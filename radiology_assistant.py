import tkinter as tk
from tkinter import ttk, filedialog, messagebox
import sys
import pandas as pd
import os
import threading
import time
import re
import json
import copy
import difflib
import shutil
import pathlib
import uuid
import io
import importlib
import base64
import subprocess
import tempfile
import webbrowser
try:
    from PIL import Image, ImageTk, ImageGrab
    PIL_AVAILABLE = True
    PIL_RESAMPLE = Image.Resampling.LANCZOS if hasattr(Image, 'Resampling') else Image.LANCZOS
except Exception:
    PIL_AVAILABLE = False
    PIL_RESAMPLE = None

try:
    import h5py
    H5PY_AVAILABLE = True
except Exception:
    H5PY_AVAILABLE = False

# Load built-in search patterns for two-agent context
# Will be dynamically loaded from user data directory if available
SEARCH_PATTERNS = {}
SEARCH_PATTERN_STEPS = {}
SEARCH_PATTERN_SHARED_STEPS = {}
radiology_search_patterns = None

# For OpenAI
try:
    from openai import OpenAI as OpenAIClient
    OPENAI_AVAILABLE = True
except ImportError:
    OPENAI_AVAILABLE = False

# For Ollama
try:
    import ollama
    OLLAMA_AVAILABLE = True
except ImportError:
    OLLAMA_AVAILABLE = False


import math
import numpy as np
from typing import Dict, List, Tuple, Optional
from datetime import datetime, timedelta


# Helper function to get the correct resource path for both script and PyInstaller bundle
def get_resource_path(relative_path):
    """Get absolute path to resource, works for dev and for PyInstaller"""
    try:
        # PyInstaller creates a temp folder and stores path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        # Running as script - use current working directory
        base_path = os.path.abspath(".")
    
    return os.path.join(base_path, relative_path)


# Helper function to safely create parent directory for a file
def ensure_parent_dir(file_path):
    """Create parent directory for file_path if it doesn't exist"""
    parent_dir = os.path.dirname(file_path)
    if parent_dir:  # Only create if dirname is not empty
        os.makedirs(parent_dir, exist_ok=True)


def get_user_data_dir():
    """Get the persistent user data directory path."""
    app_data_dir = os.path.join(os.path.expanduser("~"), ".radiology_assistant")
    os.makedirs(app_data_dir, exist_ok=True)
    return app_data_dir


# Helper function to get writable data path (for user data like study_times.csv)
def get_data_path(relative_path):
    """Get path for writable user data files in ~/.radiology_assistant."""
    try:
        app_data_dir = get_user_data_dir()
        data_file = os.path.join(app_data_dir, relative_path)

        data_dir = os.path.dirname(data_file)
        if data_dir and not os.path.exists(data_dir):
            os.makedirs(data_dir, exist_ok=True)

        if not os.path.exists(data_file):
            template_candidates = []
            if hasattr(sys, '_MEIPASS'):
                template_candidates.append(os.path.join(sys._MEIPASS, relative_path))
            template_candidates.append(os.path.abspath(relative_path))

            for template_file in template_candidates:
                if not template_file or template_file == data_file or not os.path.exists(template_file):
                    continue
                try:
                    if os.path.isdir(template_file):
                        if not os.path.exists(data_file):
                            shutil.copytree(template_file, data_file)
                    else:
                        shutil.copy2(template_file, data_file)
                    break
                except Exception as e:
                    print(f"Error copying {template_file} to {data_file}: {e}")

        return data_file
    except Exception as e:
        print(f"Error in get_data_path for {relative_path}: {e}")
    
    return os.path.join(os.path.expanduser("~"), ".radiology_assistant", relative_path)


# Semantic matcher helper: tries OpenAI embeddings, then sentence-transformers, then TF-IDF
class SemanticMatcher:
    def __init__(self, corpus: Dict[str, str], openai_client=None, openai_api_key: str = ""):
        # corpus: mapping from key -> text
        self.keys = list(corpus.keys())
        self.texts = [corpus[k] or "" for k in self.keys]
        self.openai_client = openai_client
        self.openai_api_key = openai_api_key
        self.embeddings = None
        self.backend = None

        # Try backends in order
        if OPENAI_AVAILABLE and self.openai_api_key:
            try:
                # test call light-weight: do not call until find_best to avoid unnecessary requests
                self.backend = 'openai'
            except Exception:
                self.backend = None

        if self.backend is None:
            try:
                from sentence_transformers import SentenceTransformer
                self.st_model = SentenceTransformer('all-MiniLM-L6-v2')
                self.backend = 'sbert'
            except Exception:
                self.st_model = None

        if self.backend is None:
            try:
                from sklearn.feature_extraction.text import TfidfVectorizer
                from sklearn.metrics.pairwise import cosine_similarity
                self.TfidfVectorizer = TfidfVectorizer
                self.cosine_similarity = cosine_similarity
                self.backend = 'tfidf'
            except Exception:
                self.backend = None

        # Precompute embeddings for SBERT or TF-IDF immediately; for OpenAI do lazy compute
        if self.backend == 'sbert':
            try:
                self.embeddings = self.st_model.encode(self.texts, convert_to_numpy=True, show_progress_bar=False)
            except Exception:
                self.embeddings = None
        elif self.backend == 'tfidf':
            try:
                self.vectorizer = self.TfidfVectorizer(stop_words='english')
                self.embeddings = self.vectorizer.fit_transform(self.texts)
            except Exception:
                self.embeddings = None

    def _openai_embed(self, inputs: List[str]) -> np.ndarray:
        # Use the OpenAI embeddings API via the provided client
        client = self.openai_client
        if client is None:
            client = OpenAIClient(api_key=self.openai_api_key) if OPENAI_AVAILABLE and self.openai_api_key else None
        if client is None:
            raise RuntimeError("OpenAI client not available for embeddings")
        resp = client.embeddings.create(model="text-embedding-3-small", input=inputs)
        embs = [e.embedding for e in resp.data]
        return np.array(embs, dtype=float)

    def find_best(self, query: str, preferred_term: Optional[str] = None, boost: float = 0.15) -> Tuple[Optional[str], float]:
        """Return best key and similarity score (0..1).
        If preferred_term is provided (e.g., modality like 'CT' or 'MRI'), keys containing that term
        will receive a small boost to prefer modality-consistent matches.
        """
        if not self.keys:
            return None, 0.0

        q = query.strip()
        if not q:
            return None, 0.0

        # OpenAI backend: embed query and corpus (lazy)
        if self.backend == 'openai':
            try:
                corpus_emb = self._openai_embed(self.texts)
                query_emb = self._openai_embed([q])[0]
                # cosine similarity
                norms = np.linalg.norm(corpus_emb, axis=1) * (np.linalg.norm(query_emb) + 1e-12)
                sims = (corpus_emb @ query_emb) / (norms + 1e-12)
                # Apply modality boost if requested
                if preferred_term:
                    mask = np.array([1.0 if preferred_term.lower() in k.lower() else 0.0 for k in self.keys])
                    sims = sims + (mask * boost)
                    sims = np.clip(sims, 0.0, 1.0)
                idx = int(np.argmax(sims))
                # record backend
                self.last_backend = 'openai'
                self.last_score = float(sims[idx])
                self.last_key = self.keys[idx]
                return self.keys[idx], float(sims[idx])
            except Exception:
                # fallback to difflib
                pass

        # SBERT backend
        if self.backend == 'sbert' and self.embeddings is not None:
            try:
                q_emb = self.st_model.encode([q], convert_to_numpy=True)[0]
                sims = (self.embeddings @ q_emb) / (np.linalg.norm(self.embeddings, axis=1) * (np.linalg.norm(q_emb) + 1e-12))
                if preferred_term:
                    try:
                        mask = np.array([1.0 if preferred_term.lower() in k.lower() else 0.0 for k in self.keys])
                        sims = sims + (mask * boost)
                    except Exception:
                        pass
                idx = int(np.argmax(sims))
                self.last_backend = 'sbert'
                self.last_score = float(sims[idx])
                self.last_key = self.keys[idx]
                return self.keys[idx], float(sims[idx])
            except Exception:
                pass

        # TF-IDF backend
        if self.backend == 'tfidf' and self.embeddings is not None:
            try:
                q_vec = self.vectorizer.transform([q])
                sims = self.cosine_similarity(self.embeddings, q_vec).reshape(-1)
                if preferred_term:
                    try:
                        mask = np.array([1.0 if preferred_term.lower() in k.lower() else 0.0 for k in self.keys])
                        sims = sims + (mask * boost)
                    except Exception:
                        pass
                idx = int(np.argmax(sims))
                self.last_backend = 'tfidf'
                self.last_score = float(sims[idx])
                self.last_key = self.keys[idx]
                return self.keys[idx], float(sims[idx])
            except Exception:
                pass

        # Final fallback: difflib sequence matching
        try:
            # difflib fallback
            best = max(self.keys, key=lambda k: difflib.SequenceMatcher(None, q.lower(), k.lower()).ratio())
            score = difflib.SequenceMatcher(None, q.lower(), best.lower()).ratio()
            # boost if preferred term present
            if preferred_term and preferred_term.lower() in best.lower():
                score = min(1.0, score + boost)
            self.last_backend = 'difflib'
            self.last_score = float(score)
            self.last_key = best
            return best, float(score)
        except Exception:
            return None, 0.0


class RadiologyAssistant:
    def __init__(self, root):
        self.root = root
        self.root.title("Searches")
        self.root.geometry("1400x900")
        self.root.minsize(1200, 800)

        # DataFrame now stores separate metadata columns for clarity
        self.patterns_df = pd.DataFrame(columns=["Study_Type", "Modality", "Contrast", "Indication", "Search_Pattern"])
        self.filtered_df = pd.DataFrame(columns=["Study_Type", "Modality", "Contrast", "Indication", "Search_Pattern"])
        self.current_steps = []
        self.current_step_index = 0

        self.openai_key_var = tk.StringVar()
        self.ollama_model_var = tk.StringVar(value="llama3.2:latest")

        self.modalities = ["All Modalities", "CT", "MRI", "US", "Plain Radiograph", "Nuclear Medicine"]

        # Variables to track custom data paths
        self.custom_study_times_csv = None
        self.hdf5_patterns_file = get_data_path('radiology_search_patterns.h5')
        self._text_widget_images = {}
        self._raw_image_data = {}  # widget -> {image_name: raw_bytes}

        self.setup_menu()
        self.setup_ui()

        # Timer variables
        self.timer_running = False
        self.start_time = None
        self.elapsed_time = 0
        
        # Load search patterns from user data directory on startup
        self._initialize_search_patterns()

    def _initialize_search_patterns(self):
        """Load search patterns from user data directory on startup."""
        global SEARCH_PATTERNS, SEARCH_PATTERN_STEPS
        SEARCH_PATTERNS = {}
        SEARCH_PATTERN_STEPS = {}

        if not H5PY_AVAILABLE:
            print("Warning: h5py is not installed; rich HDF5 patterns are unavailable.")
            return

        try:
            if not os.path.exists(self.hdf5_patterns_file):
                self._create_hdf5_from_python_file()
            self._reload_search_patterns()
        except Exception as e:
            print(f"Error loading search patterns from HDF5: {e}")

    def _create_hdf5_from_python_file(self):
        """Create HDF5 pattern store by importing existing radiology_search_patterns.py."""
        if not H5PY_AVAILABLE:
            return

        patterns = {}
        candidates = [
            get_data_path('radiology_search_patterns.py'),
            get_resource_path('radiology_search_patterns.py'),
            os.path.abspath('radiology_search_patterns.py'),
            os.path.abspath('dist/Searches/_internal/radiology_search_patterns.py'),
        ]

        for path in candidates:
            try:
                if not os.path.exists(path):
                    continue
                namespace = {}
                with open(path, 'r', encoding='utf-8') as f:
                    exec(f.read(), namespace)
                maybe = namespace.get('SEARCH_PATTERNS', {})
                if isinstance(maybe, dict) and maybe:
                    patterns = maybe
                    break
            except Exception:
                continue

        ensure_parent_dir(self.hdf5_patterns_file)
        with h5py.File(self.hdf5_patterns_file, 'w') as h5f:
            h5f.attrs['format_version'] = '1.0'
            root = h5f.require_group('patterns')
            for name, pattern_text in patterns.items():
                storage_key = self._pattern_storage_key(str(name))
                group = root.require_group(storage_key)
                group.attrs['pattern_name'] = str(name)
                steps = self.parse_search_pattern_text(str(pattern_text or ''))
                normalized = self._normalize_steps_for_storage(steps)
                payload = json.dumps(normalized, ensure_ascii=False)
                if 'steps_json' in group:
                    del group['steps_json']
                group.create_dataset('steps_json', data=payload, dtype=h5py.string_dtype(encoding='utf-8'))

    def _normalize_steps_for_storage(self, steps: List[dict]) -> List[dict]:
        normalized = []
        for i, step in enumerate(steps or [], 1):
            title = str((step or {}).get('step_title', '')).strip() if isinstance(step, dict) else f"Step {i}"
            content = str((step or {}).get('how_to_view_this_region', '') or '') if isinstance(step, dict) else ''
            rich_content = step.get('rich_content', []) if isinstance(step, dict) else []
            linked_step_id = str((step or {}).get('linked_step_id', '') or '').strip() if isinstance(step, dict) else ''

            entry = {
                'step_title': title,
                'how_to_view_this_region': content,
                'rich_content': rich_content,
            }
            if linked_step_id:
                entry['linked_step_id'] = linked_step_id
            normalized.append(entry)
        return normalized

    def _normalize_shared_step_for_storage(self, step: dict) -> dict:
        if not isinstance(step, dict):
            return {
                'step_title': '',
                'how_to_view_this_region': '',
                'rich_content': []
            }
        return {
            'step_title': str(step.get('step_title', '') or '').strip(),
            'how_to_view_this_region': str(step.get('how_to_view_this_region', '') or ''),
            'rich_content': copy.deepcopy(step.get('rich_content', []))
        }

    def _normalize_shared_steps_for_storage(self, shared_steps: Dict[str, dict]) -> Dict[str, dict]:
        normalized = {}
        for step_id, step_payload in (shared_steps or {}).items():
            key = str(step_id or '').strip()
            if not key:
                continue
            normalized[key] = self._normalize_shared_step_for_storage(step_payload)
        return normalized

    def _resolve_step_with_shared_content(self, step: dict) -> dict:
        global SEARCH_PATTERN_SHARED_STEPS
        normalized = self._normalize_steps_for_storage([step])[0] if isinstance(step, dict) else {
            'step_title': '',
            'how_to_view_this_region': '',
            'rich_content': []
        }

        linked_step_id = str(normalized.get('linked_step_id', '') or '').strip()
        if not linked_step_id:
            return normalized

        shared = SEARCH_PATTERN_SHARED_STEPS.get(linked_step_id)
        if not isinstance(shared, dict):
            return normalized

        shared_norm = self._normalize_shared_step_for_storage(shared)
        normalized['step_title'] = shared_norm.get('step_title', normalized.get('step_title', ''))
        normalized['how_to_view_this_region'] = shared_norm.get('how_to_view_this_region', normalized.get('how_to_view_this_region', ''))
        normalized['rich_content'] = copy.deepcopy(shared_norm.get('rich_content', normalized.get('rich_content', [])))
        normalized['linked_step_id'] = linked_step_id
        return normalized

    def _materialize_linked_steps(self, steps: List[dict]) -> List[dict]:
        normalized = self._normalize_steps_for_storage(steps)
        return [self._resolve_step_with_shared_content(step) for step in normalized]

    def _pattern_storage_key(self, pattern_name: str) -> str:
        encoded = base64.urlsafe_b64encode(pattern_name.encode('utf-8')).decode('ascii').rstrip('=')
        return f"p_{encoded}"

    def _steps_to_plain_text(self, steps: List[dict]) -> str:
        resolved_steps = self._materialize_linked_steps(steps)
        lines = []
        for i, step in enumerate(resolved_steps, 1):
            title = re.sub(r'^\d+\.\s*', '', str(step.get('step_title', '')).strip())
            suffix = " [Linked]" if str(step.get('linked_step_id', '')).strip() else ""
            lines.append(f"{i}. {title or f'Step {i}'}{suffix}")
            content = str(step.get('how_to_view_this_region', '') or '').strip()
            if content:
                lines.append(content)
            if i < len(resolved_steps):
                lines.append("")
        return "\n".join(lines)

    def _read_shared_steps_from_hdf5(self) -> Dict[str, dict]:
        if not H5PY_AVAILABLE or not os.path.exists(self.hdf5_patterns_file):
            return {}

        with h5py.File(self.hdf5_patterns_file, 'a') as h5f:
            root = h5f.require_group('patterns')
            if 'shared_steps_json' not in root:
                return {}

            try:
                raw = root['shared_steps_json'][()]
                payload = self._decode_hdf5_string(raw)
                parsed = json.loads(payload)
                if isinstance(parsed, dict):
                    return self._normalize_shared_steps_for_storage(parsed)
            except Exception:
                return {}
        return {}

    def _write_shared_steps_to_hdf5(self):
        global SEARCH_PATTERN_SHARED_STEPS
        if not H5PY_AVAILABLE:
            raise RuntimeError("h5py is not installed")

        ensure_parent_dir(self.hdf5_patterns_file)
        normalized = self._normalize_shared_steps_for_storage(SEARCH_PATTERN_SHARED_STEPS)
        payload = json.dumps(normalized, ensure_ascii=False)

        with h5py.File(self.hdf5_patterns_file, 'a') as h5f:
            root = h5f.require_group('patterns')
            if 'shared_steps_json' in root:
                del root['shared_steps_json']
            root.create_dataset('shared_steps_json', data=payload, dtype=h5py.string_dtype(encoding='utf-8'))

    def _sync_shared_step_from_step(self, step: dict):
        global SEARCH_PATTERN_SHARED_STEPS
        if not isinstance(step, dict):
            return
        linked_step_id = str(step.get('linked_step_id', '') or '').strip()
        if not linked_step_id:
            return

        SEARCH_PATTERN_SHARED_STEPS[linked_step_id] = self._normalize_shared_step_for_storage(step)

    def _ensure_shared_step_for_source(self, source_pattern: str, source_index: int, source_steps: List[dict]) -> Optional[str]:
        global SEARCH_PATTERN_STEPS, SEARCH_PATTERNS, SEARCH_PATTERN_SHARED_STEPS
        if source_index < 0 or source_index >= len(source_steps):
            return None

        source_step = source_steps[source_index]
        linked_step_id = str(source_step.get('linked_step_id', '') or '').strip()
        if not linked_step_id:
            linked_step_id = uuid.uuid4().hex

        SEARCH_PATTERN_SHARED_STEPS[linked_step_id] = self._normalize_shared_step_for_storage(source_step)

        stored_steps = self._normalize_steps_for_storage(source_steps)
        if source_index < len(stored_steps):
            stored_steps[source_index]['linked_step_id'] = linked_step_id

        SEARCH_PATTERN_STEPS[source_pattern] = self._normalize_steps_for_storage(stored_steps)
        SEARCH_PATTERNS[source_pattern] = self._steps_to_plain_text(stored_steps)

        try:
            self._write_pattern_to_hdf5(source_pattern, stored_steps)
            self._write_shared_steps_to_hdf5()
        except Exception as e:
            print(f"Warning: failed to persist linked source step '{source_pattern}': {e}")

        return linked_step_id

    def _create_linked_step_from_source(self, source_pattern: str, source_index: int, source_steps: List[dict]) -> Optional[dict]:
        linked_step_id = self._ensure_shared_step_for_source(source_pattern, source_index, source_steps)
        if not linked_step_id:
            return None

        effective_source = self._resolve_step_with_shared_content(source_steps[source_index])
        linked_step = {
            'step_title': str(effective_source.get('step_title', '') or ''),
            'how_to_view_this_region': str(effective_source.get('how_to_view_this_region', '') or ''),
            'rich_content': copy.deepcopy(effective_source.get('rich_content', [])),
            'linked_step_id': linked_step_id,
        }
        return linked_step

    def _clone_effective_step(self, step: dict, linked_step_id: Optional[str] = None) -> dict:
        effective = self._resolve_step_with_shared_content(step)
        cloned = {
            'step_title': str(effective.get('step_title', '') or ''),
            'how_to_view_this_region': str(effective.get('how_to_view_this_region', '') or ''),
            'rich_content': copy.deepcopy(effective.get('rich_content', []))
        }
        if linked_step_id:
            cloned['linked_step_id'] = linked_step_id
        return cloned

    def _get_pattern_steps_for_storage(self, pattern_name: str) -> List[dict]:
        if pattern_name in SEARCH_PATTERN_STEPS:
            return self._normalize_steps_for_storage(SEARCH_PATTERN_STEPS.get(pattern_name, []))

        pattern_text = SEARCH_PATTERNS.get(pattern_name, "")
        if pattern_text:
            return self._normalize_steps_for_storage(self.parse_search_pattern_text(pattern_text))

        return []

    def _link_current_step_with_pattern_step(self, current_step: dict, source_pattern: str, source_index: int, source_wins: bool) -> Optional[dict]:
        global SEARCH_PATTERN_STEPS, SEARCH_PATTERNS, SEARCH_PATTERN_SHARED_STEPS

        source_steps = self._get_pattern_steps_for_storage(source_pattern)
        if source_index < 0 or source_index >= len(source_steps):
            return None

        source_step = source_steps[source_index]
        linked_step_id = str(source_step.get('linked_step_id', '') or current_step.get('linked_step_id', '') or '').strip()
        if not linked_step_id:
            linked_step_id = uuid.uuid4().hex

        winning_step = source_step if source_wins else current_step
        shared_step = self._clone_effective_step(winning_step)
        SEARCH_PATTERN_SHARED_STEPS[linked_step_id] = self._normalize_shared_step_for_storage(shared_step)

        source_steps[source_index] = self._clone_effective_step(winning_step, linked_step_id=linked_step_id)
        SEARCH_PATTERN_STEPS[source_pattern] = self._normalize_steps_for_storage(source_steps)
        SEARCH_PATTERNS[source_pattern] = self._steps_to_plain_text(source_steps)

        try:
            self._write_pattern_to_hdf5(source_pattern, source_steps)
            self._write_shared_steps_to_hdf5()
        except Exception as e:
            messagebox.showerror("Link Error", f"Failed to update linked step in '{source_pattern}': {e}")
            return None

        return self._clone_effective_step(winning_step, linked_step_id=linked_step_id)

    def _prompt_link_direction(self, source_pattern: str) -> Optional[bool]:
        result = messagebox.askyesnocancel(
            "Generate Link Step",
            "Choose which step content should become the shared linked version.\n\n"
            f"Yes: replace the current step with the selected step from '{source_pattern}'.\n"
            f"No: replace the selected step in '{source_pattern}' with the current step.\n"
            "Cancel: keep both steps unchanged."
        )
        if result is None:
            return None
        return bool(result)

    def _decode_hdf5_string(self, value):
        if isinstance(value, bytes):
            return value.decode('utf-8')
        return str(value)

    def _read_all_patterns_from_hdf5(self) -> Dict[str, List[dict]]:
        result = {}
        if not H5PY_AVAILABLE or not os.path.exists(self.hdf5_patterns_file):
            return result

        with h5py.File(self.hdf5_patterns_file, 'a') as h5f:
            root = h5f.require_group('patterns')
            for storage_key in root.keys():
                group = root[storage_key]
                if not isinstance(group, h5py.Group):
                    continue
                name = str(group.attrs.get('pattern_name', storage_key))
                if 'steps_json' not in group:
                    continue
                raw = group['steps_json'][()]
                data = self._decode_hdf5_string(raw)
                try:
                    steps = json.loads(data)
                    if isinstance(steps, list):
                        result[name] = self._normalize_steps_for_storage(steps)
                except Exception:
                    result[name] = []
        return result

    def _write_pattern_to_hdf5(self, pattern_name: str, steps: List[dict]):
        if not H5PY_AVAILABLE:
            raise RuntimeError("h5py is not installed")
        ensure_parent_dir(self.hdf5_patterns_file)
        normalized = self._normalize_steps_for_storage(steps)
        payload = json.dumps(normalized, ensure_ascii=False)
        storage_key = self._pattern_storage_key(str(pattern_name))
        with h5py.File(self.hdf5_patterns_file, 'a') as h5f:
            root = h5f.require_group('patterns')
            group = root.require_group(storage_key)
            group.attrs['pattern_name'] = str(pattern_name)
            if 'steps_json' in group:
                del group['steps_json']
            group.create_dataset('steps_json', data=payload, dtype=h5py.string_dtype(encoding='utf-8'))

    def _delete_pattern_from_hdf5(self, pattern_name: str):
        if not H5PY_AVAILABLE:
            raise RuntimeError("h5py is not installed")
        with h5py.File(self.hdf5_patterns_file, 'a') as h5f:
            root = h5f.require_group('patterns')
            direct_key = self._pattern_storage_key(str(pattern_name))
            key_to_delete = direct_key if direct_key in root else None
            if key_to_delete is None:
                lowered = pattern_name.strip().lower()
                for key in root.keys():
                    display_name = str(root[key].attrs.get('pattern_name', key))
                    if display_name.strip().lower() == lowered:
                        key_to_delete = key
                        break
            if key_to_delete is None:
                raise KeyError(f"Pattern '{pattern_name}' not found")
            del root[key_to_delete]

    def _serialize_text_widget_content(self, text_widget: tk.Text) -> List[dict]:
        events = text_widget.dump('1.0', 'end-1c', text=True, tag=True, image=True)
        active_tags = set()
        rich_content = []
        image_map = self._text_widget_images.get(text_widget, {})

        for item_type, value, _ in events:
            if item_type == 'tagon':
                active_tags.add(value)
            elif item_type == 'tagoff':
                active_tags.discard(value)
            elif item_type == 'text':
                if value:
                    color = None
                    if 'red' in active_tags or 'red_edit' in active_tags:
                        color = 'red'
                    elif 'green' in active_tags or 'green_edit' in active_tags:
                        color = 'green'
                    elif 'blue' in active_tags or 'blue_edit' in active_tags:
                        color = 'blue'

                    rich_content.append({
                        'type': 'text',
                        'text': value,
                        'bold': 'bold' in active_tags or 'bold_edit' in active_tags,
                        'color': color
                    })
            elif item_type == 'image':
                pil_image = image_map.get(value)
                if pil_image is None:
                    continue
                buffer = io.BytesIO()
                pil_image.save(buffer, format='PNG')
                rich_content.append({
                    'type': 'image',
                    'format': 'png',
                    'data': base64.b64encode(buffer.getvalue()).decode('utf-8')
                })

        # --- Strip newlines adjacent to images to prevent accumulation ---
        # The renderer inserts its own \n around images, so remove the ones
        # that were captured from the widget (img_spacing tag lines, etc.).
        cleaned = []
        for i, part in enumerate(rich_content):
            if part.get('type') == 'text':
                txt = part['text']
                # If the *next* part is an image, strip trailing newlines
                next_is_image = (i + 1 < len(rich_content) and rich_content[i + 1].get('type') == 'image')
                # If the *previous* part is an image, strip leading newlines
                prev_is_image = (i - 1 >= 0 and rich_content[i - 1].get('type') == 'image')
                if next_is_image:
                    txt = txt.rstrip('\n')
                if prev_is_image:
                    txt = txt.lstrip('\n')
                if txt:  # only keep non-empty text parts
                    cleaned.append({**part, 'text': txt})
            else:
                cleaned.append(part)
        return cleaned

    def _extract_plain_text_from_rich(self, rich_content: List[dict]) -> str:
        text_parts = []
        for part in rich_content or []:
            if isinstance(part, dict) and part.get('type') == 'text':
                text_parts.append(str(part.get('text', '')))
            elif isinstance(part, dict) and part.get('type') == 'image':
                text_parts.append("\n[Image]\n")
        return ''.join(text_parts).strip()

    def _render_rich_content(self, text_widget: tk.Text, rich_content: List[dict], plain_fallback: str = "", clear: bool = True):
        text_widget.config(state='normal')
        if clear:
            text_widget.delete('1.0', tk.END)

        is_editor_widget = text_widget is getattr(self, 'popup_content', None) or text_widget is getattr(self, 'create_content_widget', None)
        is_viewer_widget = not is_editor_widget

        text_widget.tag_configure('bold', font=("Courier", 20, "bold"))
        text_widget.tag_configure('red', foreground="#ff4d4f")
        text_widget.tag_configure('green', foreground="#52c41a")
        text_widget.tag_configure('blue', foreground="#4f8cff")
        text_widget.tag_configure('bold_edit', font=("Courier", 12, "bold"))
        text_widget.tag_configure('red_edit', foreground="#c62828")
        text_widget.tag_configure('green_edit', foreground="#2e7d32")
        text_widget.tag_configure('blue_edit', foreground="#1565c0")
        text_widget.tag_configure('center_image', justify='center')
        text_widget.tag_configure('img_spacing', font=('Courier', 2), spacing1=0, spacing3=0)

        # Fixed image thumbnail limits
        img_max_w = 700
        img_max_h = 500

        image_refs = []
        image_map = {}
        raw_image_map = {}  # image_name -> raw PNG bytes for opening in Preview
        url_map = getattr(text_widget, '_url_map', {})
        url_counter = getattr(text_widget, '_url_counter', 0)

        # URL regex pattern
        url_pattern = re.compile(r'(https?://[^\s,;)\]}>\"\']+)')

        # --- Pre-process rich_content: normalize whitespace around images ---
        # Ensure exactly one \n before/after each image so gaps stay tight,
        # while preserving any intentional blank lines the user typed elsewhere.
        if rich_content and is_viewer_widget:
            normalised = []
            for i, part in enumerate(rich_content):
                if not isinstance(part, dict):
                    normalised.append(part)
                    continue
                if part.get('type') == 'image':
                    # Trim trailing newlines from the preceding text part
                    if normalised and isinstance(normalised[-1], dict) and normalised[-1].get('type') == 'text':
                        prev_text = normalised[-1]['text'].rstrip('\n')
                        if prev_text:
                            prev_text += '\n'  # keep exactly one newline
                        normalised[-1] = {**normalised[-1], 'text': prev_text}
                    normalised.append(part)
                    # Trim leading newlines from the following text part
                    if i + 1 < len(rich_content):
                        nxt = rich_content[i + 1]
                        if isinstance(nxt, dict) and nxt.get('type') == 'text':
                            stripped = nxt['text'].lstrip('\n')
                            if stripped:
                                stripped = '\n' + stripped  # keep exactly one newline
                            rich_content[i + 1] = {**nxt, 'text': stripped}
                else:
                    normalised.append(part)
            rich_content = normalised

        if rich_content:
            for part in rich_content:
                if not isinstance(part, dict):
                    continue
                if part.get('type') == 'text':
                    tags = []
                    if part.get('bold'):
                        tags.append('bold_edit' if is_editor_widget else 'bold')

                    color = part.get('color')
                    if color == 'red':
                        tags.append('red_edit' if is_editor_widget else 'red')
                    elif color == 'green':
                        tags.append('green_edit' if is_editor_widget else 'green')
                    elif color == 'blue':
                        tags.append('blue_edit' if is_editor_widget else 'blue')

                    # Insert text with URL detection for read-only viewers
                    text_str = str(part.get('text', ''))
                    if is_viewer_widget:
                        last_end = 0
                        for match in url_pattern.finditer(text_str):
                            # Insert text before URL
                            before = text_str[last_end:match.start()]
                            if before:
                                if tags:
                                    text_widget.insert(tk.END, before, tuple(tags))
                                else:
                                    text_widget.insert(tk.END, before)
                            # Insert URL with clickable tag
                            url = match.group(1)
                            url_tag = f"url_{url_counter}"
                            url_counter += 1
                            text_widget.tag_configure(url_tag, foreground="#5599ff", underline=True)
                            text_widget.tag_bind(url_tag, "<Enter>", lambda e, w=text_widget: w.config(cursor="hand2"))
                            text_widget.tag_bind(url_tag, "<Leave>", lambda e, w=text_widget: w.config(cursor=""))
                            combined_tags = list(tags) + [url_tag]
                            text_widget.insert(tk.END, url, tuple(combined_tags))
                            url_map[url_tag] = url
                            last_end = match.end()
                        # Insert remainder
                        remainder = text_str[last_end:]
                        if remainder:
                            if tags:
                                text_widget.insert(tk.END, remainder, tuple(tags))
                            else:
                                text_widget.insert(tk.END, remainder)
                    else:
                        if tags:
                            text_widget.insert(tk.END, text_str, tuple(tags))
                        else:
                            text_widget.insert(tk.END, text_str)
                elif part.get('type') == 'image':
                    raw_b64 = part.get('data', '') or ''
                    # Prefer Pillow path for resize; fall back to Tk-only if Pillow unavailable or fails
                    if PIL_AVAILABLE:
                        try:
                            raw = base64.b64decode(raw_b64)
                            image = Image.open(io.BytesIO(raw))
                            image.load()
                            # Save full-res PNG bytes for opening in Preview
                            full_buf = io.BytesIO()
                            image.save(full_buf, format='PNG')
                            full_png = full_buf.getvalue()
                            image.thumbnail((img_max_w, img_max_h), PIL_RESAMPLE)
                            tk_image = ImageTk.PhotoImage(image)
                            img_start = text_widget.index(tk.END)
                            text_widget.insert(tk.END, "\n", 'img_spacing')
                            name = text_widget.image_create(tk.END, image=tk_image)
                            text_widget.insert(tk.END, "\n", 'img_spacing')
                            text_widget.tag_add('center_image', img_start, text_widget.index(tk.END))
                            image_refs.append(tk_image)
                            image_map[name] = image.copy()
                            raw_image_map[name] = full_png
                            continue
                        except Exception:
                            pass
                    try:
                        if raw_b64:
                            raw = base64.b64decode(raw_b64)
                            tk_image = tk.PhotoImage(data=raw_b64)
                            img_start = text_widget.index(tk.END)
                            text_widget.insert(tk.END, "\n", 'img_spacing')
                            name = text_widget.image_create(tk.END, image=tk_image)
                            text_widget.insert(tk.END, "\n", 'img_spacing')
                            text_widget.tag_add('center_image', img_start, text_widget.index(tk.END))
                            image_refs.append(tk_image)
                            image_map[name] = None
                            raw_image_map[name] = raw
                            continue
                    except Exception:
                        pass
                    text_widget.insert(tk.END, "\n[Image]\n")
        elif plain_fallback:
            text_widget.insert(tk.END, plain_fallback)

        self._text_widget_images[text_widget] = image_map
        self._raw_image_data[text_widget] = raw_image_map
        setattr(text_widget, '_image_refs', image_refs)
        setattr(text_widget, '_url_map', url_map)
        setattr(text_widget, '_url_counter', url_counter)

    def _remember_selection_for_widget(self, text_widget: tk.Text, event=None):
        try:
            start = text_widget.index('sel.first')
            end = text_widget.index('sel.last')
            if start != end:
                setattr(text_widget, '_last_selection', (start, end))
        except tk.TclError:
            pass

    def _get_selection_range_for_widget(self, text_widget: tk.Text):
        try:
            start = text_widget.index('sel.first')
            end = text_widget.index('sel.last')
            if start != end:
                setattr(text_widget, '_last_selection', (start, end))
                return start, end
        except tk.TclError:
            pass

        stored = getattr(text_widget, '_last_selection', None)
        if not stored:
            return None

        try:
            start = text_widget.index(stored[0])
            end = text_widget.index(stored[1])
            if start != end:
                return start, end
        except Exception:
            pass
        return None

    def _configure_rich_text_widget(self, text_widget: tk.Text):
        text_widget.configure(undo=True, autoseparators=True, maxundo=-1, exportselection=False)
        text_widget.tag_configure('bold_edit', font=("Courier", 12, "bold"))
        text_widget.tag_configure('red_edit', foreground="#c62828")
        text_widget.tag_configure('green_edit', foreground="#2e7d32")
        text_widget.tag_configure('blue_edit', foreground="#1565c0")

        for sequence in ('<ButtonRelease-1>', '<KeyRelease>', '<<Selection>>'):
            text_widget.bind(
                sequence,
                lambda event, widget=text_widget: self._remember_selection_for_widget(widget, event),
                add='+'
            )

        text_widget.bind('<Command-b>', lambda event, widget=text_widget: self._handle_bold_shortcut(widget), add='+')
        text_widget.bind('<<Paste>>', lambda event, widget=text_widget: self._handle_rich_paste(widget), add='+')

    def _handle_bold_shortcut(self, text_widget: tk.Text):
        self._toggle_bold_on_widget(text_widget)
        return 'break'

    def _handle_rich_paste(self, text_widget: tk.Text):
        """Handle paste: if clipboard has text, let default handler paste it;
        otherwise try to paste an image from the clipboard."""
        try:
            # If the clipboard contains text (e.g. from a cut/copy), skip the
            # image-paste attempt entirely and let the default text-paste
            # handler do its job.  This avoids calling ImageGrab /
            # osascript when an image isn't on the clipboard, which can
            # crash on macOS with certain Pillow versions.
            try:
                clipboard_text = text_widget.clipboard_get()
                if clipboard_text:
                    return None  # fall through to default text paste
            except (tk.TclError, Exception):
                pass  # no text on clipboard – may be an image

            if self._paste_image_to_widget(text_widget, show_errors=False):
                return 'break'
        except Exception:
            pass  # on any unexpected error, fall through to default paste
        return None

    def _decode_macos_clipboard_image(self, clipboard_text: str):
        if not clipboard_text:
            return None

        match = re.search(r'«data\s+[A-Z0-9]{4}([0-9A-Fa-f\s]+)»', clipboard_text)
        if not match:
            return None

        hex_data = re.sub(r'\s+', '', match.group(1))
        if not hex_data:
            return None

        try:
            image = Image.open(io.BytesIO(bytes.fromhex(hex_data)))
            image.load()
            return image
        except Exception:
            return None

    def _load_image_from_clipboard(self):
        if not PIL_AVAILABLE:
            return None

        image = None
        try:
            image = ImageGrab.grabclipboard()
        except Exception:
            image = None

        if isinstance(image, Image.Image):
            return image

        if isinstance(image, list):
            for item in image:
                if isinstance(item, str) and os.path.exists(item):
                    try:
                        with Image.open(item) as file_image:
                            return file_image.copy()
                    except Exception:
                        continue

        if sys.platform == 'darwin':
            for clipboard_class in ('PNGf', 'TIFF'):
                try:
                    result = subprocess.run(
                        ['osascript', '-e', f'return the clipboard as «class {clipboard_class}»'],
                        capture_output=True,
                        text=True,
                        check=False
                    )
                except Exception:
                    continue

                if result.returncode != 0:
                    continue

                decoded = self._decode_macos_clipboard_image(result.stdout.strip())
                if decoded is not None:
                    return decoded

        return None

    def _toggle_bold_on_widget(self, text_widget: tk.Text):
        selection = self._get_selection_range_for_widget(text_widget)
        if not selection:
            text_widget.focus_set()
            return

        start, end = selection

        tag_name = 'bold_edit'
        if tag_name in text_widget.tag_names(start):
            text_widget.tag_remove(tag_name, start, end)
        else:
            text_widget.tag_add(tag_name, start, end)
        self._remember_selection_for_widget(text_widget)
        text_widget.focus_set()

    def _apply_text_color_to_widget(self, text_widget: tk.Text, color: Optional[str]):
        selection = self._get_selection_range_for_widget(text_widget)
        if not selection:
            text_widget.focus_set()
            return

        start, end = selection
        color_tags = ('red_edit', 'green_edit', 'blue_edit')
        for tag_name in color_tags:
            text_widget.tag_remove(tag_name, start, end)

        if color == 'red':
            text_widget.tag_add('red_edit', start, end)
        elif color == 'green':
            text_widget.tag_add('green_edit', start, end)
        elif color == 'blue':
            text_widget.tag_add('blue_edit', start, end)

        self._remember_selection_for_widget(text_widget)
        text_widget.focus_set()

    def _paste_image_to_widget(self, text_widget: tk.Text, show_errors: bool = True):
        if not PIL_AVAILABLE:
            if show_errors:
                messagebox.showerror("Pillow Missing", "Pillow is required for image paste support.")
            return False

        image = self._load_image_from_clipboard()

        if image is None:
            if show_errors:
                messagebox.showwarning("No Image", "Clipboard does not contain an image.")
            return False

        display_image = image.copy()
        display_image.thumbnail((700, 500), PIL_RESAMPLE)
        tk_image = ImageTk.PhotoImage(display_image)
        text_widget.focus_set()
        name = text_widget.image_create(tk.INSERT, image=tk_image)

        image_map = self._text_widget_images.setdefault(text_widget, {})
        image_map[name] = image.copy()
        refs = getattr(text_widget, '_image_refs', [])
        refs.append(tk_image)
        setattr(text_widget, '_image_refs', refs)
        text_widget.insert(tk.INSERT, "\n")
        return True

    def setup_menu(self):
        """Create the menu bar with File menu for importing and exporting data."""
        menubar = tk.Menu(self.root)
        self.root.config(menu=menubar)
        
        # File menu
        file_menu = tk.Menu(menubar, tearoff=0)
        menubar.add_cascade(label="File", menu=file_menu)
        
        file_menu.add_command(label="Import Study Log CSV...", command=self.import_study_times_csv)
        file_menu.add_command(label="Export Study Log CSV...", command=self.export_study_log_csv)
        file_menu.add_separator()
        file_menu.add_command(label="Import Search Patterns (.h5)...", command=self.import_search_patterns_h5)
        file_menu.add_command(label="Export Search Patterns (.h5)...", command=self.export_search_patterns_h5)
        file_menu.add_separator()
        file_menu.add_command(label="Reset to Default Data", command=self.reset_to_default_data)

    def _validate_patterns_h5_file(self, file_path: str):
        """Validate that an HDF5 file has a compatible search patterns structure."""
        if not H5PY_AVAILABLE:
            raise RuntimeError("h5py is not installed")

        with h5py.File(file_path, 'r') as h5f:
            if 'patterns' not in h5f:
                raise ValueError("Missing required 'patterns' group.")

            patterns_group = h5f['patterns']
            pattern_count = 0
            for key in patterns_group.keys():
                group = patterns_group[key]
                if not isinstance(group, h5py.Group):
                    continue
                if 'steps_json' not in group:
                    continue
                raw = group['steps_json'][()]
                decoded = self._decode_hdf5_string(raw)
                parsed = json.loads(decoded)
                if not isinstance(parsed, list):
                    raise ValueError(f"Pattern '{key}' has invalid steps data.")
                pattern_count += 1

            if pattern_count == 0:
                raise ValueError("No valid patterns were found in this file.")

            return pattern_count

    def import_search_patterns_h5(self):
        """Import search patterns from a user-selected .h5 file into app storage."""
        if not H5PY_AVAILABLE:
            messagebox.showerror("Import Unavailable", "h5py is not installed. Install h5py to import pattern files.")
            return

        source_path = filedialog.askopenfilename(
            title="Import Search Patterns (.h5)",
            initialdir=os.path.expanduser("~"),
            filetypes=[("HDF5 files", "*.h5 *.hdf5"), ("All files", "*.*")]
        )

        if not source_path:
            return

        try:
            pattern_count = self._validate_patterns_h5_file(source_path)

            ensure_parent_dir(self.hdf5_patterns_file)
            if os.path.exists(self.hdf5_patterns_file):
                backup_path = f"{self.hdf5_patterns_file}.bak"
                shutil.copy2(self.hdf5_patterns_file, backup_path)

            shutil.copy2(source_path, self.hdf5_patterns_file)
            self.load_builtin_patterns()

            messagebox.showinfo(
                "Import Successful",
                f"Imported {pattern_count} search pattern(s) from:\n{source_path}"
            )
        except Exception as e:
            messagebox.showerror("Import Failed", f"Could not import search patterns:\n{str(e)}")

    def export_search_patterns_h5(self):
        """Export the current search patterns HDF5 file to a user-selected location."""
        if not os.path.exists(self.hdf5_patterns_file):
            messagebox.showwarning("No Patterns File", "No search patterns file found to export.")
            return

        destination = filedialog.asksaveasfilename(
            title="Export Search Patterns (.h5)",
            initialdir=os.path.expanduser("~"),
            defaultextension=".h5",
            initialfile="radiology_search_patterns_export.h5",
            filetypes=[("HDF5 files", "*.h5"), ("All files", "*.*")]
        )

        if not destination:
            return

        try:
            shutil.copy2(self.hdf5_patterns_file, destination)
            messagebox.showinfo("Export Successful", f"Search patterns exported to:\n{destination}")
        except Exception as e:
            messagebox.showerror("Export Failed", f"Failed to export search patterns:\n{str(e)}")

    def import_study_times_csv(self):
        """Allow user to select a custom study_times.csv file."""
        file_path = filedialog.askopenfilename(
            title="Select Study Times CSV",
            initialdir=os.path.expanduser("~"),
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        
        if file_path:
            # Verify it's a valid CSV
            try:
                # Try to read it to validate
                test_df = pd.read_csv(file_path)
                self.custom_study_times_csv = file_path
                messagebox.showinfo(
                    "Study Times CSV Imported",
                    f"Study times CSV set to:\n{file_path}\n\nThe application will now use data from this file."
                )
                # Refresh the Study Log tab
                if hasattr(self, 'times_tab'):
                    self.setup_times_tab()
                    self.update_rvu_total()
            except Exception as e:
                messagebox.showerror("Invalid CSV", f"Could not read the CSV file:\n{str(e)}")

    def reset_to_default_data(self):
        """Reset to using default data files."""
        result = messagebox.askyesno(
            "Reset to Default Data",
            "This will reset the application to use the default data files.\n\n" +
            "Your custom data will not be deleted, but the application will stop using it.\n\n" +
            "Continue?"
        )
        
        if result:
            self.custom_study_times_csv = None
            
            # Refresh the UI
            if hasattr(self, 'times_tab'):
                self.setup_times_tab()
                self.update_rvu_total()
            
            self.load_builtin_patterns()
            
            messagebox.showinfo(
                "Reset Complete",
                "Application has been reset to use default data files."
            )

    def export_study_log_csv(self):
        """Export the current study log (study_times.csv) to a user-selected location."""
        # Get source study times CSV
        source_csv = self.get_study_times_csv_path()
        
        if not os.path.exists(source_csv):
            messagebox.showwarning(
                "No Study Log Found",
                "No study log file found to export."
            )
            return
        
        # Ask user where to save
        destination = filedialog.asksaveasfilename(
            title="Export Study Log CSV",
            initialdir=os.path.expanduser("~"),
            defaultextension=".csv",
            initialfile="study_times_export.csv",
            filetypes=[("CSV files", "*.csv"), ("All files", "*.*")]
        )
        
        if destination:
            try:
                shutil.copy2(source_csv, destination)
                messagebox.showinfo(
                    "Export Successful",
                    f"Study log exported to:\n{destination}"
                )
            except Exception as e:
                messagebox.showerror(
                    "Export Failed",
                    f"Failed to export study log:\n{str(e)}"
                )

    def get_study_times_csv_path(self):
        """Get the path to the study_times.csv file (custom or default)."""
        if self.custom_study_times_csv:
            return self.custom_study_times_csv
        return get_data_path('study_times.csv')

    def parse_search_pattern_text(self, text: str) -> List[dict]:
        """
        Parse plain text search pattern into structured steps.
        Handles numbered steps (1., 2., ...), alphabetical substeps (a., b., ...),
        and numeric sub-substeps (1., 11., 111., ... or i., ii., iii., ...).
        """
        lines = text.split('\n')
        steps = []
        current_step = None
        current_substeps = []
        current_content = []
        
        # Regex patterns for different levels
        main_step_pattern = re.compile(r'^(\d+)\.\s+(.+)$')  # 1. Step title
        alpha_substep_pattern = re.compile(r'^\s*([a-z])\.\s+(.+)$')  # a. Substep
        numeric_substep_pattern = re.compile(r'^\s*(1{1,3}|i{1,3}|v{1,3}|1v|v1)\.\s+(.+)$', re.IGNORECASE)  # 1., 11., 111., i., ii., iii., iv., v., vi., vii., etc.
        
        def flush_current_step():
            """Save the current step being built."""
            if current_step is not None:
                # Join substeps into formatted text
                substep_text = '\n'.join(current_substeps)
                current_step['how_to_view_this_region'] = substep_text
                steps.append(current_step)
        
        for line in lines:
            line_stripped = line.rstrip()
            if not line_stripped:
                if current_step is not None:
                    # Preserve paragraph spacing inside a step
                    if not current_substeps or current_substeps[-1] != "":
                        current_substeps.append("")
                continue
                
            # Check for main step (1., 2., etc.)
            main_match = main_step_pattern.match(line_stripped)
            if main_match:
                # Save previous step
                flush_current_step()
                
                # Start new step
                step_num = main_match.group(1)
                step_title = main_match.group(2).strip()
                current_step = {
                    'step_title': f"{step_num}. {step_title}",
                    'how_to_view_this_region': '',
                }
                current_substeps = []
                continue
            
            # Check for alphabetical substep (a., b., etc.)
            alpha_match = alpha_substep_pattern.match(line_stripped)
            if alpha_match and current_step is not None:
                letter = alpha_match.group(1)
                content = alpha_match.group(2).strip()
                current_substeps.append(f"  {letter}. {content}")
                continue
            
            # Check for numeric substep (1., 11., 111., i., ii., iii., etc.)
            numeric_match = numeric_substep_pattern.match(line_stripped)
            if numeric_match and current_step is not None:
                marker = numeric_match.group(1)
                content = numeric_match.group(2).strip()
                current_substeps.append(f"    {marker}. {content}")
                continue
            
            # Otherwise, it's continuation content for the current substep
            if current_step is not None and line_stripped:
                # Add as continuation, maintaining some indentation
                current_substeps.append(f"       {line_stripped.strip()}")
        
        # Don't forget the last step
        flush_current_step()
        
        return steps


    def setup_ui(self):
        self.notebook = ttk.Notebook(self.root)
        self.notebook.pack(expand=True, fill='both', padx=15, pady=15)

        self.view_tab = ttk.Frame(self.notebook)
        self.times_tab = ttk.Frame(self.notebook)
        self.calc_tab = ttk.Frame(self.notebook)

        self.notebook.add(self.view_tab, text="Search Patterns")
        self.notebook.add(self.times_tab, text="Study Log")
        self.notebook.add(self.calc_tab, text="Calculations")

        self.setup_view_tab()
        self.setup_times_tab()
        self.setup_calculations_tab()

    def setup_view_tab(self):
        # Search/filter bar
        search_frame = ttk.Frame(self.view_tab)
        search_frame.pack(fill='x', pady=(10, 0), padx=30)
        
        ttk.Label(search_frame, text="Filter Patterns:", font=("Helvetica", 12)).pack(side='left', padx=(0, 10))
        self.pattern_filter_var = tk.StringVar()
        self.pattern_filter_var.trace('w', lambda *args: self.filter_patterns())
        filter_entry = ttk.Entry(search_frame, textvariable=self.pattern_filter_var, width=50, font=("Helvetica", 12))
        filter_entry.pack(side='left')
        ttk.Button(search_frame, text="Clear", command=lambda: self.pattern_filter_var.set("")).pack(side='left', padx=(10, 0))
        
        top_frame = ttk.Frame(self.view_tab)
        top_frame.pack(fill='x', pady=(0, 20), padx=30)

        # Search pattern selector
        ttk.Label(top_frame, text="Search Pattern:", font=("Helvetica", 14, "bold")).pack(side='left', padx=(0, 15))
        self.study_combo = ttk.Combobox(top_frame, width=60, state="readonly", font=("Helvetica", 13))
        self.study_combo.pack(side='left')
        self.study_combo.bind("<<ComboboxSelected>>", self.on_study_selected)
        
        # Edit button on same row with more space
        ttk.Button(top_frame, text="Edit Selected Pattern", command=lambda: self.open_edit_popup()).pack(side='left', padx=(20, 0))
        
        # Create New Pattern button
        ttk.Button(top_frame, text="Create New Pattern", command=lambda: self.open_create_pattern_popup()).pack(side='left', padx=(10, 0))

        # Reference button – opens a mini viewer for a different pattern
        ttk.Button(top_frame, text="Reference", command=self.open_reference_popup).pack(side='left', padx=(10, 0))

        info_frame = ttk.Frame(self.view_tab)
        info_frame.pack(fill='x', pady=10, padx=30)

        self.study_label = ttk.Label(info_frame, text="No pattern loaded", font=("Helvetica", 18, "bold"), foreground="#ffffff", wraplength=800, anchor='w')
        self.study_label.pack(side='left')

        self.step_counter_label = ttk.Label(info_frame, text="", font=("Helvetica", 14), foreground="#aaaaaa")
        self.step_counter_label.pack(side='left', padx=50)

        self.timer_button = ttk.Button(info_frame, text="Start/Reset Timer", command=self.start_reset_timer)
        self.timer_button.pack(side='right', padx=(10, 0))

        self.timer_label = ttk.Label(info_frame, text="Elapsed: 00:00", font=("Helvetica", 14), foreground="#aaaaaa")
        self.timer_label.pack(side='right')
        # Cancel Study button: stop timer and record the study time
        self.cancel_button = ttk.Button(info_frame, text="Record", command=self.cancel_study)
        self.cancel_button.pack(side='right', padx=(10, 0))

        viewer_frame = ttk.Frame(self.view_tab)
        viewer_frame.pack(fill='both', expand=True, padx=60, pady=30)

        self.step_title_label = ttk.Label(
            viewer_frame,
            text="",
            font=("Courier", 28, "bold"),
            foreground="#00ddff",
            anchor='center'
        )
        self.step_title_label.pack(fill='x', pady=(0, 10))

        self.step_text = tk.Text(viewer_frame, wrap='word', background="#333333", foreground="#ffffff", bd=0, highlightthickness=0)
        self.step_text.pack(fill='both', expand=True)

        self._configure_step_text_tags()  # configure text tags

        self.step_text.config(state='disabled')

        # Bind click handler for images and links in step_text
        self.step_text.bind("<Button-1>", self._on_step_text_click)

        # Replace nav hint with daily RVU summary label (updated dynamically)
        self.rvu_label = ttk.Label(self.view_tab, text="RVUs today: 0", font=("Helvetica", 13, "bold"), foreground="#00ddff")
        self.rvu_label.place(relx=1.0, x=-15, y=8, anchor='ne')
        self.rvu_label.lift()
        # Bind navigation keys for the main viewer
        self.root.bind("<Left>", lambda e: self.prev_step())
        self.root.bind("<Right>", lambda e: self.next_step())

        # Bind Up/Down arrows to open and navigate the search pattern dropdown
        self.root.bind("<Up>", self._on_arrow_key_combo)
        self.root.bind("<Down>", self._on_arrow_key_combo)

        # Bind spacebar to trigger Record when on Search Patterns tab
        self.root.bind("<space>", self._on_space_record)

        # Initialize with built-in patterns
        self.root.after(100, self.load_builtin_patterns)
        # Update RVU total on startup
        self.root.after(200, self.update_rvu_total)

    def _open_edit_popup_impl(self):
        current = getattr(self, 'current_loaded_study', None)
        if not current:
            messagebox.showerror("No pattern", "No pattern is currently loaded to edit.")
            return

        if getattr(self, 'edit_popup', None) and tk.Toplevel.winfo_exists(self.edit_popup):
            try:
                self.edit_popup.lift()
            except Exception:
                pass
            return

        self.edit_popup = tk.Toplevel(self.root)
        self.edit_popup.title(f"Edit Pattern: {current}")
        self.edit_popup.geometry("1100x750")

        popup_frame = ttk.Frame(self.edit_popup)
        popup_frame.pack(fill='both', expand=True, padx=12, pady=12)
        ttk.Label(popup_frame, text=f"Editing: {current}", font=("Helvetica", 16, "bold")).pack(pady=(0, 10))

        editor_row = ttk.Frame(popup_frame)
        editor_row.pack(fill='both', expand=True, pady=6)

        left = ttk.Frame(editor_row)
        left.pack(side='left', fill='y', padx=(0, 8))
        ttk.Label(left, text="Steps:", font=("Helvetica", 14, "bold")).pack(anchor='w', pady=(0, 6))
        self.step_listbox = tk.Listbox(left, width=40, activestyle='none', font=("Helvetica", 13))
        self.step_listbox.pack(fill='y', expand=True, side='left')
        step_scroll = ttk.Scrollbar(left, orient='vertical', command=self.step_listbox.yview)
        step_scroll.pack(side='right', fill='y')
        self.step_listbox['yscrollcommand'] = step_scroll.set

        step_btns = ttk.Frame(left)
        step_btns.pack(fill='x', pady=8)
        ttk.Button(step_btns, text="Add Step", command=lambda: add_step()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Delete Step", command=lambda: delete_step()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Move Up", command=lambda: move_up()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Move Down", command=lambda: move_down()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Copy Steps From...", command=lambda: copy_steps_from_pattern()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Generate Link Step...", command=lambda: link_steps_from_pattern()).pack(fill='x', pady=2)

        right = ttk.Frame(editor_row)
        right.pack(side='left', fill='both', expand=True)

        ttk.Label(right, text="Step Title:", font=("Helvetica", 13, "bold")).pack(anchor='w')
        self.popup_step_title = ttk.Entry(right, font=("Helvetica", 13))
        self.popup_step_title.pack(fill='x', pady=(2, 8))

        toolbar = ttk.Frame(right)
        toolbar.pack(fill='x', pady=(0, 4))
        ttk.Button(toolbar, text="Bold", command=lambda: self._toggle_bold_on_widget(self.popup_content)).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Red", command=lambda: self._apply_text_color_to_widget(self.popup_content, 'red')).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Green", command=lambda: self._apply_text_color_to_widget(self.popup_content, 'green')).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Blue", command=lambda: self._apply_text_color_to_widget(self.popup_content, 'blue')).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Default", command=lambda: self._apply_text_color_to_widget(self.popup_content, None)).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Paste Image", command=lambda: self._paste_image_to_widget(self.popup_content)).pack(side='left')

        ttk.Label(right, text="Step Content:", font=("Helvetica", 13, "bold")).pack(anchor='w')
        text_frame = ttk.Frame(right)
        text_frame.pack(fill='both', expand=True, pady=(2, 8))
        self.popup_content = tk.Text(text_frame, wrap='word', font=("Courier", 12))
        self.popup_content.pack(fill='both', expand=True, side='left')
        self._configure_rich_text_widget(self.popup_content)
        content_scroll = ttk.Scrollbar(text_frame, orient='vertical', command=self.popup_content.yview)
        content_scroll.pack(side='right', fill='y')
        self.popup_content['yscrollcommand'] = content_scroll.set

        btn_row = ttk.Frame(popup_frame)
        btn_row.pack(fill='x', pady=12)
        ttk.Button(btn_row, text="Save Changes", command=lambda: save_current_step()).pack(side='left', padx=(0, 8))
        ttk.Button(btn_row, text="Save All & Close", command=lambda: save_all_and_close()).pack(side='left', padx=(0, 8))
        ttk.Button(btn_row, text="Delete Entire Pattern", command=lambda: delete_entire_pattern()).pack(side='left', padx=(8, 0))
        ttk.Button(btn_row, text="Cancel", command=lambda: self._close_edit_popup()).pack(side='right')

        popup_steps = []
        popup_selected_idx = {'idx': max(0, int(getattr(self, 'current_step_index', 0) or 0))}

        def populate_listbox():
            self.step_listbox.delete(0, tk.END)
            for i, s in enumerate(popup_steps):
                title = re.sub(r'^\d+\.\s*', '', s.get('step_title', f"Step {i+1}"))
                s['step_title'] = f"{i+1}. {title}"
                suffix = " [Linked]" if str(s.get('linked_step_id', '')).strip() else ""
                self.step_listbox.insert(tk.END, f"{i+1}. {title}{suffix}")
            idx = popup_selected_idx.get('idx', 0)
            if popup_steps:
                idx = max(0, min(int(idx), len(popup_steps) - 1))
                popup_selected_idx['idx'] = idx
                self.step_listbox.selection_clear(0, tk.END)
                self.step_listbox.select_set(idx)
                self.step_listbox.see(idx)
                load_selected_step(idx)

        def load_selected_step(index: int):
            if index < 0 or index >= len(popup_steps):
                return
            s = self._resolve_step_with_shared_content(popup_steps[index])
            popup_selected_idx['idx'] = index
            self.popup_step_title.delete(0, tk.END)
            self.popup_step_title.insert(0, s.get('step_title', ''))
            self._render_rich_content(self.popup_content, s.get('rich_content', []), s.get('how_to_view_this_region', ''), clear=True)

        def save_current_step():
            idx = popup_selected_idx.get('idx')
            if idx is None or idx < 0 or idx >= len(popup_steps):
                return
            rich_content = self._serialize_text_widget_content(self.popup_content)
            new_title = self.popup_step_title.get().strip()
            linked_step_id = str(popup_steps[idx].get('linked_step_id', '') or '').strip()
            popup_steps[idx]['step_title'] = new_title
            popup_steps[idx]['rich_content'] = rich_content
            popup_steps[idx]['how_to_view_this_region'] = self._extract_plain_text_from_rich(rich_content)
            if linked_step_id:
                popup_steps[idx]['linked_step_id'] = linked_step_id
                self._sync_shared_step_from_step(popup_steps[idx])
            # Update the listbox label in-place (no full rebuild, keeps selection stable)
            display_title = re.sub(r'^\d+\.\s*', '', new_title)
            display_title = f"{idx+1}. {display_title}"
            popup_steps[idx]['step_title'] = display_title
            self.step_listbox.delete(idx)
            linked_suffix = " [Linked]" if linked_step_id else ""
            self.step_listbox.insert(idx, f"{display_title}{linked_suffix}")

        def on_select(event):
            sel = self.step_listbox.curselection()
            if not sel:
                return
            new_idx = sel[0]
            if new_idx == popup_selected_idx.get('idx'):
                return  # already showing this step
            save_current_step()
            popup_selected_idx['idx'] = new_idx
            # Re-highlight the clicked item (save may have tweaked the listbox)
            self.step_listbox.selection_clear(0, tk.END)
            self.step_listbox.select_set(new_idx)
            load_selected_step(new_idx)

        def add_step():
            popup_steps.append({'step_title': 'New Step', 'how_to_view_this_region': '', 'rich_content': []})
            popup_selected_idx['idx'] = len(popup_steps) - 1
            populate_listbox()

        def delete_step():
            idx = popup_selected_idx.get('idx')
            if idx is None or idx < 0 or idx >= len(popup_steps):
                return
            if len(popup_steps) <= 1:
                messagebox.showwarning("Cannot Delete", "Cannot delete the last step.")
                return
            del popup_steps[idx]
            popup_selected_idx['idx'] = min(idx, len(popup_steps) - 1)
            populate_listbox()

        def move_up():
            idx = popup_selected_idx.get('idx')
            if idx is None or idx <= 0:
                return
            save_current_step()
            popup_steps[idx-1], popup_steps[idx] = popup_steps[idx], popup_steps[idx-1]
            popup_selected_idx['idx'] = idx - 1
            populate_listbox()

        def move_down():
            idx = popup_selected_idx.get('idx')
            if idx is None or idx >= len(popup_steps) - 1:
                return
            save_current_step()
            popup_steps[idx+1], popup_steps[idx] = popup_steps[idx], popup_steps[idx+1]
            popup_selected_idx['idx'] = idx + 1
            populate_listbox()

        def copy_steps_from_pattern():
            save_current_step()

            def on_copy(copied_steps: List[dict], source_name: str):
                if not copied_steps:
                    return
                start_idx = len(popup_steps)
                popup_steps.extend(copied_steps)
                popup_selected_idx['idx'] = start_idx
                populate_listbox()
                messagebox.showinfo("Steps Copied", f"Copied {len(copied_steps)} step(s) from '{source_name}'.")

            self._open_copy_steps_dialog(self.edit_popup, on_copy, exclude_pattern=current)

        def link_steps_from_pattern():
            save_current_step()

            current_idx = popup_selected_idx.get('idx')
            if current_idx is None or current_idx < 0 or current_idx >= len(popup_steps):
                messagebox.showwarning("No Step Selected", "Please select a current step to link.")
                return

            def on_link(source_name: str, source_index: int, source_step: dict):
                del source_step
                source_wins = self._prompt_link_direction(source_name)
                if source_wins is None:
                    return

                linked_step = self._link_current_step_with_pattern_step(popup_steps[current_idx], source_name, source_index, source_wins)
                if not linked_step:
                    return

                popup_steps[current_idx] = linked_step
                popup_selected_idx['idx'] = current_idx
                populate_listbox()
                if source_wins:
                    messagebox.showinfo("Step Linked", f"The current step is now linked to the selected step from '{source_name}'.")
                else:
                    messagebox.showinfo("Step Linked", f"The selected step in '{source_name}' was replaced and linked to the current step.")

            self._open_copy_steps_dialog(self.edit_popup, on_link, exclude_pattern=current, link_mode=True)

        def save_all_and_close():
            selected_idx = popup_selected_idx.get('idx', 0)
            save_current_step()
            for s in popup_steps:
                self._sync_shared_step_from_step(s)
            self._save_pattern_edits_to_file(current, popup_steps)
            self._reload_search_patterns()
            self.load_pattern(current, restart_timer=False)
            if self.current_steps:
                self.current_step_index = max(0, min(int(selected_idx), len(self.current_steps) - 1))
            else:
                self.current_step_index = 0
            self.display_current_step()
            self._close_edit_popup()
            messagebox.showinfo("Saved", "Changes saved successfully.")

        def delete_entire_pattern():
            result = messagebox.askyesno(
                "Confirm Delete",
                f"Are you sure you want to permanently delete the pattern '{current}'?\n\nThis action cannot be undone."
            )
            if not result:
                return
            self._delete_pattern_from_file(current)
            self._reload_search_patterns()
            self.load_builtin_patterns()
            self.current_steps = []
            self.display_current_step()
            self.study_label.config(text="No pattern selected")
            self._close_edit_popup()
            messagebox.showinfo("Deleted", f"Pattern '{current}' has been deleted successfully!")

        initial_steps = self._get_pattern_steps_for_storage(current)
        if not initial_steps:
            initial_steps = self._normalize_steps_for_storage(self.current_steps)

        for s in initial_steps:
            if isinstance(s, dict):
                resolved = self._resolve_step_with_shared_content(s)
                item = {
                    'step_title': resolved.get('step_title', ''),
                    'how_to_view_this_region': resolved.get('how_to_view_this_region', ''),
                    'rich_content': copy.deepcopy(resolved.get('rich_content', []))
                }
                linked_step_id = str(s.get('linked_step_id', '') or '').strip()
                if linked_step_id:
                    item['linked_step_id'] = linked_step_id
                popup_steps.append(item)

        self.step_listbox.bind('<<ListboxSelect>>', on_select)

        def on_up_key(event):
            sel = self.step_listbox.curselection()
            if not sel:
                return "break"
            idx = sel[0]
            if idx > 0:
                save_current_step()
                new_idx = idx - 1
                self.step_listbox.selection_clear(0, tk.END)
                self.step_listbox.selection_set(new_idx)
                self.step_listbox.see(new_idx)
                load_selected_step(new_idx)
            return "break"

        def on_down_key(event):
            sel = self.step_listbox.curselection()
            if not sel:
                return "break"
            idx = sel[0]
            if idx < len(popup_steps) - 1:
                save_current_step()
                new_idx = idx + 1
                self.step_listbox.selection_clear(0, tk.END)
                self.step_listbox.selection_set(new_idx)
                self.step_listbox.see(new_idx)
                load_selected_step(new_idx)
            return "break"

        self.step_listbox.bind('<Up>', on_up_key)
        self.step_listbox.bind('<Down>', on_down_key)
        populate_listbox()

    # ------------------------------------------------------------------ #
    #                      Reference Popup Window                        #
    # ------------------------------------------------------------------ #
    def open_reference_popup(self):
        """Open (or focus) a mini reference window that lets the user browse
        any search pattern without affecting the main viewer's timer or state."""
        # If the window already exists, just bring it to front
        if hasattr(self, '_ref_popup') and self._ref_popup is not None:
            try:
                self._ref_popup.lift()
                self._ref_popup.focus_force()
                return
            except tk.TclError:
                self._ref_popup = None

        popup = tk.Toplevel(self.root)
        popup.title("Reference Pattern Viewer")
        popup.geometry("900x650")
        popup.minsize(700, 450)
        popup.configure(bg="#2b2b2b")
        self._ref_popup = popup

        # --- Local state for the reference viewer ---
        ref_steps = []       # current steps list
        ref_index = [0]      # mutable int (list so nested funcs can mutate)

        # ---- Top bar: pattern selector ----
        sel_frame = ttk.Frame(popup)
        sel_frame.pack(fill='x', padx=15, pady=(12, 4))

        ttk.Label(sel_frame, text="Pattern:", font=("Helvetica", 12, "bold")).pack(side='left', padx=(0, 8))

        ref_filter_var = tk.StringVar()
        filter_entry = ttk.Entry(sel_frame, textvariable=ref_filter_var, width=25, font=("Helvetica", 12))
        filter_entry.pack(side='left', padx=(0, 8))

        ref_combo = ttk.Combobox(sel_frame, width=50, state="readonly", font=("Helvetica", 12))
        ref_combo.pack(side='left')

        all_names = sorted(list(SEARCH_PATTERNS.keys()))
        ref_combo['values'] = all_names

        def _filter_ref(*_args):
            txt = ref_filter_var.get().lower()
            if not txt:
                ref_combo['values'] = all_names
            else:
                ref_combo['values'] = [n for n in all_names if txt in n.lower()]
        ref_filter_var.trace('w', _filter_ref)

        ttk.Button(sel_frame, text="Clear", command=lambda: ref_filter_var.set("")).pack(side='left', padx=(6, 0))

        # ---- Info bar: title + step counter ----
        info_bar = ttk.Frame(popup)
        info_bar.pack(fill='x', padx=15, pady=(4, 0))

        ref_title_lbl = ttk.Label(info_bar, text="Select a pattern above", font=("Helvetica", 15, "bold"), foreground="#ffffff", wraplength=650, anchor='w')
        ref_title_lbl.pack(side='left')

        ref_step_counter = ttk.Label(info_bar, text="", font=("Helvetica", 12), foreground="#aaaaaa")
        ref_step_counter.pack(side='right')

        # ---- Step title ----
        ref_step_title = ttk.Label(popup, text="", font=("Courier", 22, "bold"), foreground="#00ddff", anchor='center')
        ref_step_title.pack(fill='x', padx=30, pady=(6, 2))

        # ---- Content area ----
        ref_text = tk.Text(popup, wrap='word', background="#333333", foreground="#ffffff",
                           bd=0, highlightthickness=0, font=("Courier", 16))
        ref_text.pack(fill='both', expand=True, padx=30, pady=(4, 8))
        ref_text.tag_configure('bold', font=("Courier", 16, "bold"))
        ref_text.tag_configure('red', foreground="#ff4d4f")
        ref_text.tag_configure('green', foreground="#52c41a")
        ref_text.tag_configure('step_name', font=("Courier", 24, "bold"), foreground="#00ddff", justify='center')
        ref_text.tag_configure('detail_label', font=("Courier", 18, "bold"), foreground="#ffdd00")
        ref_text.tag_configure('detail_content', font=("Courier", 16), foreground="#dddddd")
        ref_text.config(state='disabled')
        # Bind click handler for images and links in ref_text
        ref_text.bind("<Button-1>", self._on_step_text_click)

        # ---- Navigation bar ----
        nav_frame = ttk.Frame(popup)
        nav_frame.pack(fill='x', padx=15, pady=(0, 10))

        prev_btn = ttk.Button(nav_frame, text="\u25C0  Previous")
        prev_btn.pack(side='left')

        next_btn = ttk.Button(nav_frame, text="Next  \u25B6")
        next_btn.pack(side='right')

        # ---- Helper: display a step ----
        def _display_ref_step():
            ref_text.config(state='normal')
            ref_text.delete('1.0', tk.END)
            title_display = ""
            steps_len = len(ref_steps)
            if not ref_steps:
                ref_text.insert(tk.END, "No steps loaded.", "detail_content")
            elif ref_index[0] < steps_len:
                step = ref_steps[ref_index[0]]
                title_display = step.get('step_title', 'Untitled Step')
                rich = step.get('rich_content', [])
                if rich:
                    self._render_rich_content(ref_text, rich, clear=False)
                    ref_text.insert(tk.END, "\n\n", "detail_content")
                else:
                    content = step.get('how_to_view_this_region', '')
                    if content:
                        ref_text.insert(tk.END, f"{content}\n\n", "detail_content")
            else:
                title_display = "END"
                ref_text.insert(tk.END, "End of reference pattern.", "detail_content")
            ref_step_title.config(text=title_display)
            ref_text.config(state='disabled')
            # Update counter
            if ref_steps and ref_index[0] < steps_len:
                ref_step_counter.config(text=f"Step {ref_index[0]+1} of {steps_len}")
            elif ref_steps:
                ref_step_counter.config(text="Finished")
            else:
                ref_step_counter.config(text="")

        # ---- Helper: load a pattern locally ----
        def _load_ref_pattern(event=None):
            name = ref_combo.get()
            if not name:
                return
            if name in SEARCH_PATTERN_STEPS:
                ref_steps[:] = self._materialize_linked_steps(SEARCH_PATTERN_STEPS.get(name, []))
            elif name in SEARCH_PATTERNS:
                ref_steps[:] = self._materialize_linked_steps(self.parse_search_pattern_text(SEARCH_PATTERNS[name]))
            else:
                ref_steps.clear()
            ref_index[0] = 0
            ref_title_lbl.config(text=name)
            _display_ref_step()

        ref_combo.bind("<<ComboboxSelected>>", _load_ref_pattern)

        # ---- Navigation callbacks ----
        def _prev(_e=None):
            if ref_index[0] > 0:
                ref_index[0] -= 1
                _display_ref_step()

        def _next(_e=None):
            if ref_index[0] < len(ref_steps):
                ref_index[0] += 1
                _display_ref_step()

        prev_btn.config(command=_prev)
        next_btn.config(command=_next)

        # Arrow-key bindings scoped to the popup
        popup.bind("<Left>", _prev)
        popup.bind("<Right>", _next)

        # Cleanup reference when popup is closed
        def _on_close():
            self._ref_popup = None
            popup.destroy()
        popup.protocol("WM_DELETE_WINDOW", _on_close)

    def open_edit_popup(self):
        return self._open_edit_popup_impl()

    def _close_edit_popup(self):
        if getattr(self, 'edit_popup', None) and tk.Toplevel.winfo_exists(self.edit_popup):
            try:
                self.edit_popup.destroy()
            except Exception:
                pass
        self.popup_content = None

        self.root.bind("<Left>", lambda e: self.prev_step())
        self.root.bind("<Right>", lambda e: self.next_step())

    def open_create_pattern_popup(self):
        """Open a popup window for creating a new search pattern."""
        # If a popup already exists, bring it to front
        if getattr(self, 'create_popup', None) and tk.Toplevel.winfo_exists(self.create_popup):
            try:
                self.create_popup.lift()
            except Exception:
                pass
            return

        self.create_popup = tk.Toplevel(self.root)
        self.create_popup.title("Create New Search Pattern")
        self.create_popup.geometry("1100x800")

        popup_frame = ttk.Frame(self.create_popup)
        popup_frame.pack(fill='both', expand=True, padx=12, pady=12)

        # Title label
        ttk.Label(popup_frame, text="Create New Search Pattern", font=("Helvetica", 16, "bold")).pack(pady=(0, 10))

        # Pattern name input
        name_frame = ttk.Frame(popup_frame)
        name_frame.pack(fill='x', pady=(0, 10))
        ttk.Label(name_frame, text="Pattern Name:", font=("Helvetica", 13, "bold")).pack(side='left', padx=(0, 10))
        pattern_name_entry = ttk.Entry(name_frame, width=50, font=("Helvetica", 13))
        pattern_name_entry.pack(side='left', fill='x', expand=True)

        # Template selector
        template_frame = ttk.Frame(popup_frame)
        template_frame.pack(fill='x', pady=(0, 10))
        ttk.Label(template_frame, text="Start from template (optional):", font=("Helvetica", 13, "bold")).pack(side='left', padx=(0, 10))
        template_combo = ttk.Combobox(template_frame, width=50, state="readonly", font=("Helvetica", 13))
        template_combo['values'] = ["-- Start from scratch --"] + sorted(list(SEARCH_PATTERNS.keys()))
        template_combo.set("-- Start from scratch --")
        template_combo.pack(side='left')

        # Main editor layout: list of steps on left, editable field on right
        editor_row = ttk.Frame(popup_frame)
        editor_row.pack(fill='both', expand=True, pady=6)

        # Left: listbox of steps
        left = ttk.Frame(editor_row)
        left.pack(side='left', fill='y', padx=(0, 8))
        ttk.Label(left, text="Steps:", font=("Helvetica", 14, "bold")).pack(anchor='w', pady=(0, 6))
        create_step_listbox = tk.Listbox(left, width=40, activestyle='none', font=("Helvetica", 13))
        create_step_listbox.pack(fill='y', expand=True, side='left')
        step_scroll = ttk.Scrollbar(left, orient='vertical', command=create_step_listbox.yview)
        step_scroll.pack(side='right', fill='y')
        create_step_listbox['yscrollcommand'] = step_scroll.set

        # Step operation buttons
        step_btns = ttk.Frame(left)
        step_btns.pack(fill='x', pady=8)
        ttk.Button(step_btns, text="Add Step", command=lambda: add_step()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Delete Step", command=lambda: delete_step()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Move Up", command=lambda: move_up()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Move Down", command=lambda: move_down()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Copy Steps From...", command=lambda: copy_steps_from_pattern()).pack(fill='x', pady=2)
        ttk.Button(step_btns, text="Generate Link Step...", command=lambda: link_steps_from_pattern()).pack(fill='x', pady=2)

        # Right: editable field for selected step
        right = ttk.Frame(editor_row)
        right.pack(side='left', fill='both', expand=True)

        ttk.Label(right, text="Step Title:", font=("Helvetica", 13, "bold")).pack(anchor='w')
        create_step_title = ttk.Entry(right, font=("Helvetica", 13))
        create_step_title.pack(fill='x', pady=(2, 8))

        toolbar = ttk.Frame(right)
        toolbar.pack(fill='x', pady=(0, 4))
        ttk.Button(toolbar, text="Bold", command=lambda: self._toggle_bold_on_widget(create_content)).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Red", command=lambda: self._apply_text_color_to_widget(create_content, 'red')).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Green", command=lambda: self._apply_text_color_to_widget(create_content, 'green')).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Default", command=lambda: self._apply_text_color_to_widget(create_content, None)).pack(side='left', padx=(0, 6))
        ttk.Button(toolbar, text="Paste Image", command=lambda: self._paste_image_to_widget(create_content)).pack(side='left')

        ttk.Label(right, text="Step Content:", font=("Helvetica", 13, "bold")).pack(anchor='w')
        text_frame = ttk.Frame(right)
        text_frame.pack(fill='both', expand=True, pady=(2, 8))
        create_content = tk.Text(text_frame, wrap='word', font=("Courier", 12))
        self.create_content_widget = create_content
        create_content.pack(fill='both', expand=True, side='left')
        self._configure_rich_text_widget(create_content)
        content_scroll = ttk.Scrollbar(text_frame, orient='vertical', command=create_content.yview)
        content_scroll.pack(side='right', fill='y')
        create_content['yscrollcommand'] = content_scroll.set

        # Buttons at bottom
        btn_row = ttk.Frame(popup_frame)
        btn_row.pack(fill='x', pady=12)
        ttk.Button(btn_row, text="Save Changes", command=lambda: save_current_step()).pack(side='left', padx=(0, 8))
        ttk.Button(btn_row, text="Save Pattern & Close", command=lambda: save_pattern_and_close()).pack(side='left', padx=(0, 8))
        ttk.Button(btn_row, text="Cancel", command=lambda: self._close_create_popup()).pack(side='right')

        # Internal list of steps for popup editing
        popup_steps = []
        popup_selected_idx = {'idx': 0}

        def populate_listbox():
            create_step_listbox.delete(0, tk.END)
            for i, s in enumerate(popup_steps):
                title = s.get('step_title', f"Step {i+1}")
                # Strip leading number and period from title to avoid duplication
                title = re.sub(r'^\d+\.\s*', '', title)
                s['step_title'] = f"{i+1}. {title}"
                suffix = " [Linked]" if str(s.get('linked_step_id', '')).strip() else ""
                create_step_listbox.insert(tk.END, f"{i+1}. {title}{suffix}")
            # Restore selection
            idx = popup_selected_idx.get('idx', 0)
            if 0 <= idx < len(popup_steps):
                create_step_listbox.select_set(idx)
                create_step_listbox.see(idx)
                load_selected_step(idx)

        def load_selected_step(index: int):
            if index < 0 or index >= len(popup_steps):
                return
            s = self._resolve_step_with_shared_content(popup_steps[index])
            popup_selected_idx['idx'] = index
            create_step_title.delete(0, tk.END)
            create_step_title.insert(0, s.get('step_title', ''))
            self._render_rich_content(create_content, s.get('rich_content', []), s.get('how_to_view_this_region', ''), clear=True)

        def save_current_step():
            """Save changes to the currently selected step."""
            idx = popup_selected_idx.get('idx')
            if idx is None or idx < 0 or idx >= len(popup_steps):
                return
            rich_content = self._serialize_text_widget_content(create_content)
            new_title = create_step_title.get().strip()
            linked_step_id = str(popup_steps[idx].get('linked_step_id', '') or '').strip()
            popup_steps[idx]['step_title'] = new_title
            popup_steps[idx]['rich_content'] = rich_content
            popup_steps[idx]['how_to_view_this_region'] = self._extract_plain_text_from_rich(rich_content)
            if linked_step_id:
                popup_steps[idx]['linked_step_id'] = linked_step_id
                self._sync_shared_step_from_step(popup_steps[idx])
            # Update the listbox label in-place (no full rebuild)
            display_title = re.sub(r'^\d+\.\s*', '', new_title)
            display_title = f"{idx+1}. {display_title}"
            popup_steps[idx]['step_title'] = display_title
            create_step_listbox.delete(idx)
            linked_suffix = " [Linked]" if linked_step_id else ""
            create_step_listbox.insert(idx, f"{display_title}{linked_suffix}")

        def on_select(event):
            sel = create_step_listbox.curselection()
            if not sel:
                return
            new_idx = sel[0]
            if new_idx == popup_selected_idx.get('idx'):
                return
            save_current_step()
            popup_selected_idx['idx'] = new_idx
            create_step_listbox.selection_clear(0, tk.END)
            create_step_listbox.select_set(new_idx)
            load_selected_step(new_idx)

        def add_step():
            new = {'step_title': 'New Step', 'how_to_view_this_region': '', 'rich_content': []}
            popup_steps.append(new)
            popup_selected_idx['idx'] = len(popup_steps) - 1
            populate_listbox()

        def delete_step():
            idx = popup_selected_idx.get('idx')
            if idx is None or idx < 0 or idx >= len(popup_steps):
                return
            if len(popup_steps) <= 1:
                messagebox.showwarning("Cannot Delete", "Pattern must have at least one step.")
                return
            del popup_steps[idx]
            if idx >= len(popup_steps):
                popup_selected_idx['idx'] = len(popup_steps) - 1
            populate_listbox()

        def move_up():
            idx = popup_selected_idx.get('idx')
            if idx is None or idx <= 0:
                return
            save_current_step()
            popup_steps[idx-1], popup_steps[idx] = popup_steps[idx], popup_steps[idx-1]
            popup_selected_idx['idx'] = idx - 1
            populate_listbox()

        def move_down():
            idx = popup_selected_idx.get('idx')
            if idx is None or idx >= len(popup_steps) - 1:
                return
            save_current_step()
            popup_steps[idx+1], popup_steps[idx] = popup_steps[idx], popup_steps[idx+1]
            popup_selected_idx['idx'] = idx + 1
            populate_listbox()

        def copy_steps_from_pattern():
            save_current_step()

            def on_copy(copied_steps: List[dict], source_name: str):
                if not copied_steps:
                    return
                start_idx = len(popup_steps)
                popup_steps.extend(copied_steps)
                popup_selected_idx['idx'] = start_idx
                populate_listbox()
                messagebox.showinfo("Steps Copied", f"Copied {len(copied_steps)} step(s) from '{source_name}'.")

            self._open_copy_steps_dialog(self.create_popup, on_copy)

        def link_steps_from_pattern():
            save_current_step()

            current_idx = popup_selected_idx.get('idx')
            if current_idx is None or current_idx < 0 or current_idx >= len(popup_steps):
                messagebox.showwarning("No Step Selected", "Please select a current step to link.")
                return

            def on_link(source_name: str, source_index: int, source_step: dict):
                del source_step
                source_wins = self._prompt_link_direction(source_name)
                if source_wins is None:
                    return

                linked_step = self._link_current_step_with_pattern_step(popup_steps[current_idx], source_name, source_index, source_wins)
                if not linked_step:
                    return

                popup_steps[current_idx] = linked_step
                popup_selected_idx['idx'] = current_idx
                populate_listbox()
                if source_wins:
                    messagebox.showinfo("Step Linked", f"The current step is now linked to the selected step from '{source_name}'.")
                else:
                    messagebox.showinfo("Step Linked", f"The selected step in '{source_name}' was replaced and linked to the current step.")

            self._open_copy_steps_dialog(self.create_popup, on_link, link_mode=True)

        def load_template(event=None):
            """Load a template pattern when selected."""
            template_name = template_combo.get()
            if template_name == "-- Start from scratch --":
                return
            
            if template_name in SEARCH_PATTERNS:
                temp_steps = SEARCH_PATTERN_STEPS.get(template_name)
                if not temp_steps:
                    pattern_text = SEARCH_PATTERNS[template_name]
                    temp_steps = self.parse_search_pattern_text(pattern_text)
                temp_steps = self._materialize_linked_steps(temp_steps)
                
                # Copy steps to popup_steps
                popup_steps.clear()
                for s in temp_steps:
                    if isinstance(s, dict):
                        item = {
                            'step_title': s.get('step_title', ''),
                            'how_to_view_this_region': s.get('how_to_view_this_region', ''),
                            'rich_content': s.get('rich_content', [])
                        }
                        linked_step_id = str(s.get('linked_step_id', '') or '').strip()
                        if linked_step_id:
                            item['linked_step_id'] = linked_step_id
                        popup_steps.append(item)
                
                popup_selected_idx['idx'] = 0
                populate_listbox()

        def save_pattern_and_close():
            """Save the new pattern to the Python file."""
            save_current_step()  # Save any pending changes
            for s in popup_steps:
                self._sync_shared_step_from_step(s)
            
            pattern_name = pattern_name_entry.get().strip()
            if not pattern_name:
                messagebox.showerror("Invalid Name", "Please enter a pattern name.")
                return
            
            if pattern_name in SEARCH_PATTERNS:
                if not messagebox.askyesno("Pattern Exists", f"A pattern named '{pattern_name}' already exists. Overwrite it?"):
                    return
            
            if not popup_steps:
                messagebox.showerror("No Steps", "Pattern must have at least one step.")
                return
            
            # Save the new pattern
            self._append_new_pattern_to_file(pattern_name, popup_steps)
            # Reload the module
            self._reload_search_patterns()
            # Update the combo box
            self.load_builtin_patterns()
            # Select the new pattern
            self.study_combo.set(pattern_name)
            self.load_pattern(pattern_name)
            
            self._close_create_popup()
            messagebox.showinfo("Saved", f"Pattern '{pattern_name}' created successfully!")

        # Bind events
        create_step_listbox.bind('<<ListboxSelect>>', on_select)
        template_combo.bind('<<ComboboxSelected>>', load_template)
        
        # Bind arrow keys
        def on_up_key(event):
            sel = create_step_listbox.curselection()
            if not sel:
                return "break"
            idx = sel[0]
            if idx > 0:
                save_current_step()
                new_idx = idx - 1
                create_step_listbox.selection_clear(0, tk.END)
                create_step_listbox.selection_set(new_idx)
                create_step_listbox.see(new_idx)
                load_selected_step(new_idx)
            return "break"
        
        def on_down_key(event):
            sel = create_step_listbox.curselection()
            if not sel:
                return "break"
            idx = sel[0]
            if idx < len(popup_steps) - 1:
                save_current_step()
                new_idx = idx + 1
                create_step_listbox.selection_clear(0, tk.END)
                create_step_listbox.selection_set(new_idx)
                create_step_listbox.see(new_idx)
                load_selected_step(new_idx)
            return "break"
        
        create_step_listbox.bind('<Up>', on_up_key)
        create_step_listbox.bind('<Down>', on_down_key)

        # Start with one empty step
        popup_steps.append({'step_title': 'Step 1', 'how_to_view_this_region': '', 'rich_content': []})
        populate_listbox()

    def _close_create_popup(self):
        if getattr(self, 'create_popup', None) and tk.Toplevel.winfo_exists(self.create_popup):
            try:
                self.create_popup.destroy()
            except Exception:
                pass
        self.create_content_widget = None

    def _get_pattern_steps_for_copy(self, pattern_name: str) -> List[dict]:
        """Return normalized steps for a named pattern from loaded storage."""
        if pattern_name in SEARCH_PATTERN_STEPS:
            loaded_steps = SEARCH_PATTERN_STEPS.get(pattern_name) or []
            if loaded_steps:
                return self._materialize_linked_steps(loaded_steps)

        pattern_text = SEARCH_PATTERNS.get(pattern_name, "")
        if pattern_text:
            return self._materialize_linked_steps(self.parse_search_pattern_text(pattern_text))

        return []

    def _open_copy_steps_dialog(self, parent, on_copy, exclude_pattern: Optional[str] = None, link_mode: bool = False):
        """Open a picker dialog to copy selected steps from another search pattern."""
        pattern_names = sorted(set(SEARCH_PATTERNS.keys()) | set(SEARCH_PATTERN_STEPS.keys()))
        if exclude_pattern:
            pattern_names = [name for name in pattern_names if name != exclude_pattern]

        if not pattern_names:
            messagebox.showwarning("No Source Patterns", "No other patterns are available to copy from.")
            return

        dialog = tk.Toplevel(parent)
        dialog.title("Generate Link Step" if link_mode else "Copy Steps From Pattern")
        dialog.geometry("1050x620")
        dialog.transient(parent)
        dialog.grab_set()

        root_frame = ttk.Frame(dialog)
        root_frame.pack(fill='both', expand=True, padx=12, pady=12)

        ttk.Label(
            root_frame,
            text="Select one step from another search pattern to link to the current step:" if link_mode else "Select a source pattern and choose one or more steps to copy:",
            font=("Helvetica", 12, "bold")
        ).pack(anchor='w', pady=(0, 8))

        source_row = ttk.Frame(root_frame)
        source_row.pack(fill='x', pady=(0, 8))
        ttk.Label(source_row, text="Source Pattern:", font=("Helvetica", 11)).pack(side='left', padx=(0, 8))
        source_combo = ttk.Combobox(source_row, values=pattern_names, state='readonly', width=70, font=("Helvetica", 11))
        source_combo.pack(side='left', fill='x', expand=True)

        content_row = ttk.Frame(root_frame)
        content_row.pack(fill='both', expand=True)

        steps_frame = ttk.Frame(content_row)
        steps_frame.pack(side='left', fill='both', expand=True, padx=(0, 8))
        steps_listbox = tk.Listbox(steps_frame, selectmode=tk.SINGLE if link_mode else tk.EXTENDED, activestyle='none', font=("Helvetica", 12))
        steps_listbox.pack(side='left', fill='both', expand=True)
        steps_scroll = ttk.Scrollbar(steps_frame, orient='vertical', command=steps_listbox.yview)
        steps_scroll.pack(side='right', fill='y')
        steps_listbox['yscrollcommand'] = steps_scroll.set

        preview_frame = ttk.Frame(content_row)
        preview_frame.pack(side='left', fill='both', expand=True)
        ttk.Label(preview_frame, text="Step Preview:", font=("Helvetica", 11, "bold")).pack(anchor='w', pady=(0, 4))
        preview_text = tk.Text(
            preview_frame,
            wrap='word',
            font=("Courier", 11),
            background="#333333",
            foreground="#ffffff",
            bd=0,
            highlightthickness=0
        )
        preview_text.pack(side='left', fill='both', expand=True)
        self._configure_rich_text_widget(preview_text)
        preview_scroll = ttk.Scrollbar(preview_frame, orient='vertical', command=preview_text.yview)
        preview_scroll.pack(side='right', fill='y')
        preview_text['yscrollcommand'] = preview_scroll.set
        preview_text.config(state='disabled')

        source_steps: List[dict] = []

        def clear_preview(message: str = "Select a step to preview."):
            preview_text.config(state='normal')
            preview_text.delete('1.0', tk.END)
            preview_text.insert(tk.END, message)
            preview_text.config(state='disabled')

        def preview_step(index: int):
            preview_text.config(state='normal')
            preview_text.delete('1.0', tk.END)

            if index < 0 or index >= len(source_steps):
                preview_text.insert(tk.END, "Select a step to preview.")
                preview_text.config(state='disabled')
                return

            step = source_steps[index]
            title = str(step.get('step_title', '')).strip() or f"Step {index + 1}"
            preview_text.insert(tk.END, f"{title}\n\n")

            rich = step.get('rich_content', [])
            plain = str(step.get('how_to_view_this_region', '') or '')
            if rich:
                self._render_rich_content(preview_text, rich, plain, clear=False)
            elif plain:
                preview_text.insert(tk.END, plain)
            else:
                preview_text.insert(tk.END, "(No content for this step.)")

            preview_text.config(state='disabled')

        def load_source_steps(event=None):
            del event
            steps_listbox.delete(0, tk.END)
            source_steps.clear()
            clear_preview()
            source_name = source_combo.get()
            if not source_name:
                return

            source_steps.extend(self._get_pattern_steps_for_copy(source_name))
            for i, step in enumerate(source_steps, 1):
                title = re.sub(r'^\d+\.\s*', '', str(step.get('step_title', '')).strip())
                steps_listbox.insert(tk.END, f"{i}. {title or f'Step {i}'}")

            if source_steps:
                steps_listbox.selection_clear(0, tk.END)
                steps_listbox.selection_set(0)
                steps_listbox.see(0)
                preview_step(0)

        def on_step_selection(event=None):
            del event
            sel = steps_listbox.curselection()
            if not sel:
                clear_preview()
                return
            preview_step(sel[-1])

        action_row = ttk.Frame(root_frame)
        action_row.pack(fill='x', pady=(10, 0))

        def copy_selected():
            source_name = source_combo.get()
            if not source_name:
                messagebox.showwarning("Select Source", "Please select a source pattern.")
                return

            selected_indices = list(steps_listbox.curselection())
            if not selected_indices:
                messagebox.showwarning("Select Steps", "Please select at least one step to link." if link_mode else "Please select at least one step to copy.")
                return

            if link_mode:
                selected_index = selected_indices[-1]
                if selected_index < 0 or selected_index >= len(source_steps):
                    messagebox.showwarning("Select Step", "Please select a valid source step.")
                    return
                on_copy(source_name, selected_index, source_steps[selected_index])
                dialog.destroy()
                return

            copied_steps = []
            for idx in selected_indices:
                if idx < 0 or idx >= len(source_steps):
                    continue
                step = source_steps[idx]
                copied_steps.append({
                    'step_title': str(step.get('step_title', '') or ''),
                    'how_to_view_this_region': str(step.get('how_to_view_this_region', '') or ''),
                    'rich_content': copy.deepcopy(step.get('rich_content', []))
                })

            if not copied_steps:
                messagebox.showwarning("No Steps", "No steps could be linked from the selected pattern." if link_mode else "No steps could be copied from the selected pattern.")
                return

            on_copy(copied_steps, source_name)
            dialog.destroy()

        if not link_mode:
            ttk.Button(action_row, text="Select All", command=lambda: steps_listbox.select_set(0, tk.END)).pack(side='left')
        ttk.Button(action_row, text="Select Step" if link_mode else "Copy Selected", command=copy_selected).pack(side='left', padx=(8, 0))
        ttk.Button(action_row, text="Cancel", command=dialog.destroy).pack(side='right')

        source_combo.bind('<<ComboboxSelected>>', load_source_steps)
        steps_listbox.bind('<<ListboxSelect>>', on_step_selection)
        source_combo.set(pattern_names[0])
        load_source_steps()

    def _save_pattern_edits_to_file(self, pattern_name: str, steps: List[dict]):
        """Save edited pattern steps to HDF5."""
        try:
            self._write_pattern_to_hdf5(pattern_name, steps)
            self._write_shared_steps_to_hdf5()
        except Exception as e:
            messagebox.showerror("Save Error", f"Failed to save edits: {e}")

    def _reload_search_patterns(self):
        """Reload search patterns from HDF5."""
        global SEARCH_PATTERNS, SEARCH_PATTERN_STEPS, SEARCH_PATTERN_SHARED_STEPS
        try:
            if not H5PY_AVAILABLE:
                messagebox.showerror("Reload Error", "h5py is not installed. Please install h5py to use pattern storage.")
                return
            if not os.path.exists(self.hdf5_patterns_file):
                self._create_hdf5_from_python_file()

            SEARCH_PATTERN_STEPS = self._read_all_patterns_from_hdf5()
            SEARCH_PATTERN_SHARED_STEPS = self._read_shared_steps_from_hdf5()
            SEARCH_PATTERNS = {
                name: self._steps_to_plain_text(steps)
                for name, steps in SEARCH_PATTERN_STEPS.items()
            }

            if hasattr(self, 'study_combo'):
                pattern_names = sorted(list(SEARCH_PATTERNS.keys()))
                self.all_pattern_names = pattern_names
                self.study_combo['values'] = pattern_names
        except Exception as e:
            messagebox.showerror("Reload Error", f"Failed to reload patterns: {e}")

    def _append_new_pattern_to_file(self, pattern_name: str, steps: List[dict]):
        """Append or update a pattern in HDF5."""
        try:
            self._write_pattern_to_hdf5(pattern_name, steps)
            self._write_shared_steps_to_hdf5()
        except Exception as e:
            messagebox.showerror("Save Error", f"Failed to save new pattern: {e}")

    def _delete_pattern_from_file(self, pattern_name: str):
        """Delete a pattern from HDF5 storage."""
        try:
            self._delete_pattern_from_hdf5(pattern_name)
        except Exception as e:
            messagebox.showerror("Delete Error", f"Failed to delete pattern: {e}")

    def setup_generate_tab(self):
        llm_frame = ttk.LabelFrame(self.generate_tab, text="LLM Provider & Connection")
        llm_frame.pack(fill='x', padx=30, pady=20)

        provider_row = ttk.Frame(llm_frame)
        provider_row.pack(pady=15)
        self.llm_provider = tk.StringVar(value="openai")
        ttk.Radiobutton(provider_row, text="Ollama (Local)", variable=self.llm_provider, value="ollama",
                        command=self.toggle_provider_ui).pack(side='left', padx=80)
        ttk.Radiobutton(provider_row, text="OpenAI (ChatGPT)", variable=self.llm_provider, value="openai",
                        command=self.toggle_provider_ui).pack(side='left', padx=80)

        self.key_frame = ttk.Frame(llm_frame)
        self.key_frame.pack(pady=10)
        ttk.Label(self.key_frame, text="OpenAI API Key:", font=("Helvetica", 11)).pack(side='left', padx=(80,10))
        self.key_entry = ttk.Entry(self.key_frame, textvariable=self.openai_key_var, show="*", width=50)
        self.key_entry.pack(side='left', padx=10)

        test_row = ttk.Frame(llm_frame)
        test_row.pack(pady=15)
        self.test_btn = ttk.Button(test_row, text="Test Connection", command=self.start_connection_test)
        self.test_btn.pack(side='left', padx=80)
        self.progress = ttk.Progressbar(test_row, mode='indeterminate', length=250)
        self.progress.pack(side='left', padx=15)
        self.status_label = ttk.Label(test_row, text="Status: Not tested", foreground="gray", font=("Helvetica", 11))
        self.status_label.pack(side='left', padx=20)

        gen_frame = ttk.LabelFrame(self.generate_tab, text="Generate New Search Pattern")
        gen_frame.pack(fill='x', padx=30, pady=30)

        modality_row = ttk.Frame(gen_frame)
        modality_row.pack(pady=8, fill='x')
        ttk.Label(modality_row, text="Modality:", font=("Helvetica", 13)).pack(side='left', padx=50)
        gen_modalities = [m for m in self.modalities if m != "All Modalities"]
        self.new_modality_var = tk.StringVar()
        self.new_modality_combo = ttk.Combobox(modality_row, values=gen_modalities,
                                              state="readonly", width=30, font=("Helvetica", 12), textvariable=self.new_modality_var)
        self.new_modality_combo.pack(side='left', padx=20)
        if gen_modalities:
            self.new_modality_combo.set(gen_modalities[0])

        ttk.Label(modality_row, text="Contrast:", font=("Helvetica", 13)).pack(side='left', padx=(30, 8))
        contrast_options = ["With Contrast", "Without Contrast"]
        self.contrast_var = tk.StringVar(value="With Contrast")
        self.contrast_combo = ttk.Combobox(modality_row, values=contrast_options,
                                          state='readonly', width=20, font=("Helvetica", 12), textvariable=self.contrast_var)
        self.contrast_combo.pack(side='left')

        indication_row = ttk.Frame(gen_frame)
        indication_row.pack(pady=8, fill='x')
        ttk.Label(indication_row, text="Indication:", font=("Helvetica", 13)).pack(side='left', padx=50)
        self.include_indication_var = tk.BooleanVar(value=True)
        self.indication_check = ttk.Checkbutton(indication_row, variable=self.include_indication_var)
        self.indication_check.pack(side='left', padx=(0,8))
        self.indication_entry = ttk.Entry(indication_row, font=("Helvetica", 13), width=65)
        self.indication_entry.pack(side='left', padx=12)
        self.indication_entry.insert(0, "e.g., chest pain, shortness of breath")

        study_row = ttk.Frame(gen_frame)
        study_row.pack(pady=12, fill='x')
        ttk.Label(study_row, text="Study Type:", font=("Helvetica", 13)).pack(side='left', padx=50)
        self.new_study_entry = ttk.Entry(study_row, font=("Helvetica", 13), width=70)
        self.new_study_entry.pack(side='left', padx=20)
        self.new_study_entry.insert(0, "e.g., Chest")

        style_row = ttk.Frame(gen_frame)
        style_row.pack(pady=20, fill='x')
        ttk.Label(style_row, text="Pattern Style:", font=("Helvetica", 13)).pack(side='left', padx=50)
        self.prompt_style_combo = ttk.Combobox(style_row, values=list(self.prompt_styles.keys()),
                                               state="readonly", width=55, font=("Helvetica", 12))
        self.prompt_style_combo.pack(side='left', padx=20)
        if self.prompt_styles:
            self.prompt_style_combo.set(list(self.prompt_styles.keys())[0])

        ttk.Label(style_row, text="Model (Ollama):", font=("Helvetica", 13)).pack(side='left', padx=(80,15))
        self.model_entry = ttk.Entry(style_row, textvariable=self.ollama_model_var, width=30, font=("Helvetica", 12))
        self.model_entry.pack(side='left', padx=10)

        # Matching strictness selector
        strict_row = ttk.Frame(gen_frame)
        strict_row.pack(pady=6, fill='x')
        ttk.Label(strict_row, text="Matching Strictness:", font=("Helvetica", 12)).pack(side='left', padx=50)
        self.matching_strictness_var = tk.StringVar(value="Strict")
        self.matching_strictness_combo = ttk.Combobox(strict_row, values=["Loose", "Default", "Strict"], state='readonly', width=18, textvariable=self.matching_strictness_var)
        self.matching_strictness_combo.pack(side='left', padx=12)
        # Map strictness to (threshold, boost)
        self.strictness_map = {
            "Loose": (0.35, 0.12),
            "Default": (0.55, 0.18),
            "Strict": (0.70, 0.25)
        }

        # Option to pull directly from radiology_search_patterns.py
        import_row = ttk.Frame(gen_frame)
        import_row.pack(pady=15, fill='x', padx=50)
        ttk.Label(import_row, text="Or import from built-in patterns:", font=("Helvetica", 12)).pack(side='left', padx=(0,12))
        ttk.Button(import_row, text="Select Pattern from radiology_search_patterns.py", command=self.import_pattern_from_dict).pack(side='left')

        generate_row = ttk.Frame(gen_frame)
        generate_row.pack(pady=30)

        self.generate_btn = ttk.Button(generate_row, text="GENERATE DETAILED PATTERN", command=self.start_generation_thread,
                                       style="Accent.TButton")
        self.generate_btn.pack()

        self.gen_progress = ttk.Progressbar(generate_row, mode='indeterminate', length=400)
        self.gen_progress.pack(pady=15)
        self.gen_progress.pack_forget()

        style = ttk.Style()
        style.configure("Accent.TButton", font=("Helvetica", 16, "bold"), padding=15)

        # Reference/context viewer (editable) shown under generation controls
        ref_frame = ttk.LabelFrame(gen_frame, text="Reference Context (editable)")
        # Keep the reference/context area visible and allow it to expand when generating
        ref_frame.pack(fill='both', padx=30, pady=(10, 20), expand=True)

        ref_top = ttk.Frame(ref_frame)
        ref_top.pack(fill='x', padx=8, pady=(6, 0))
        ttk.Label(ref_top, text="Matched Pattern:", font=("Helvetica", 11, "bold")).pack(side='left')
        self.matched_label = ttk.Label(ref_top, text="(none)", font=("Helvetica", 11), foreground="#666666")
        self.matched_label.pack(side='left', padx=(6,0))
        # Status for the semantic AI agent (matching / generating)
        self.agent_status_label = ttk.Label(ref_top, text="AI agent: idle", font=("Helvetica", 10), foreground="#0077aa")
        self.agent_status_label.pack(side='left', padx=(12,0))
        ttk.Button(ref_top, text="Clear", command=lambda: self.reference_text.delete(1.0, tk.END)).pack(side='right')

        text_frame = ttk.Frame(ref_frame)
        text_frame.pack(fill='both', expand=True, padx=8, pady=8)
        self.reference_text = tk.Text(text_frame, height=14, wrap='word')
        self.reference_text.pack(side='left', fill='both', expand=True)
        ref_scroll = ttk.Scrollbar(text_frame, orient='vertical', command=self.reference_text.yview)
        ref_scroll.pack(side='right', fill='y')
        self.reference_text['yscrollcommand'] = ref_scroll.set

        # Put a small hint below
        ttk.Label(ref_frame, text="This text is prepended to the LLM prompt as context. Edit as needed.", font=("Helvetica", 9), foreground="#888888").pack(anchor='w', padx=8, pady=(0,8))

        self.toggle_provider_ui()

    def toggle_provider_ui(self):
        if self.llm_provider.get() == "openai":
            self.key_frame.pack(pady=10)
            self.model_entry.config(state='disabled')
        else:
            self.key_frame.pack_forget()
            self.model_entry.config(state='normal')

    def start_connection_test(self):
        self.test_btn.config(state='disabled')
        self.progress.start(10)
        self.status_label.config(text="Testing...", foreground="orange")
        threading.Thread(target=self.test_connections, daemon=True).start()

    def test_connections(self):
        provider = self.llm_provider.get()
        openai_ok = ollama_ok = False
        if provider == "openai" and self.openai_key_var.get().strip() and OPENAI_AVAILABLE:
            try:
                client = OpenAIClient(api_key=self.openai_key_var.get().strip())
                client.models.list()
                openai_ok = True
            except Exception:
                openai_ok = False
        elif provider == "ollama" and OLLAMA_AVAILABLE:
            try:
                ollama.list()
                ollama_ok = True
            except Exception:
                ollama_ok = False
        time.sleep(0.5)
        self.root.after(0, self.finish_connection_test, provider, openai_ok, ollama_ok)

    def finish_connection_test(self, provider, openai_ok, ollama_ok):
        self.progress.stop()
        self.test_btn.config(state='normal')
        if provider == "openai":
            text = "✅ OpenAI: Connected" if openai_ok else "❌ OpenAI: Invalid or missing key"
            color = "green" if openai_ok else "red"
        else:
            text = "✅ Ollama: Running" if ollama_ok else "❌ Ollama: Not running or not installed"
            color = "green" if ollama_ok else "red"
        self.status_label.config(text=text, foreground=color)

    def start_reset_timer(self):
        if not self.current_steps:
            messagebox.showwarning("No Pattern", "Please load a search pattern first to start the timer.")
            return

        # Reset to first step
        self.current_step_index = 0

        # Reset timer
        self.start_time = time.time()
        self.elapsed_time = 0
        self.timer_running = True

        # Update display
        self.display_current_step()
        self.update_timer()

    def stop_timer(self):
        if self.timer_running:
            self.elapsed_time = time.time() - self.start_time
            self.timer_running = False
            self.update_timer()

    def update_timer(self):
        if self.timer_running:
            elapsed = time.time() - self.start_time
        else:
            elapsed = self.elapsed_time

        hours, remainder = divmod(int(elapsed), 3600)
        mins, secs = divmod(remainder, 60)
        time_str = f"{hours:02d}:{mins:02d}:{secs:02d}" if hours > 0 else f"{mins:02d}:{secs:02d}"
        self.timer_label.config(text=f"Elapsed: {time_str}")

        if self.timer_running:
            self.root.after(1000, self.update_timer)

    def load_builtin_patterns(self):
        """Load patterns from SEARCH_PATTERNS dict."""
        self._reload_search_patterns()
        if SEARCH_PATTERNS:
            pattern_names = sorted(list(SEARCH_PATTERNS.keys()))
            self.all_pattern_names = pattern_names  # Store for filtering
            self.study_combo['values'] = pattern_names
            if pattern_names:
                self.study_combo.current(0)
                self.load_pattern(pattern_names[0])
        else:
            messagebox.showwarning("No Built-in Patterns", "No built-in search patterns available.")
            self.all_pattern_names = []
            self.study_combo['values'] = []
            self.study_combo.set("")

    def filter_patterns(self):
        """Filter the pattern combobox based on search text."""
        search_text = self.pattern_filter_var.get().lower()
        
        if not search_text:
            # No filter, show all patterns
            self.study_combo['values'] = self.all_pattern_names
        else:
            # Filter patterns that contain the search text
            filtered = [name for name in self.all_pattern_names if search_text in name.lower()]
            self.study_combo['values'] = filtered
            
            # If current selection is not in filtered list, clear it
            current = self.study_combo.get()
            if current and current not in filtered:
                self.study_combo.set('')

    def _on_space_record(self, event):
        """Trigger the Record button when spacebar is pressed on the Search Patterns tab."""
        # Only act when the Search Patterns tab is selected
        try:
            if self.notebook.select() != str(self.view_tab):
                return
        except Exception:
            return

        # Don't intercept if focus is in an editable widget
        try:
            focused = self.root.focus_get()
        except KeyError:
            return
        if focused and focused is not self.step_text and isinstance(focused, (tk.Entry, tk.Text, tk.Listbox, ttk.Entry, ttk.Combobox)):
            return

        self.cancel_study()
        return "break"

    def _on_arrow_key_combo(self, event):
        """Open the search pattern dropdown on Up/Down arrow when on Search Patterns tab."""
        # Only act when the Search Patterns tab is selected
        try:
            if self.notebook.select() != str(self.view_tab):
                return
        except Exception:
            return

        # Don't intercept if focus is in an editable Entry or Listbox (but allow
        # the read-only step_text viewer so arrows still open the dropdown)
        try:
            focused = self.root.focus_get()
        except KeyError:
            # Combobox popdown frame can't be resolved — dropdown is already open
            return
        if focused and focused is not self.step_text and isinstance(focused, (tk.Entry, tk.Text, tk.Listbox, ttk.Entry)):
            return

        # Open the dropdown and focus the combobox
        self.study_combo.focus_set()
        self.study_combo.event_generate('<Down>')
        return "break"

    def on_study_selected(self, event=None):
        """Load the selected study and start/reset the timer."""
        selected_study = self.study_combo.get().strip() if hasattr(self, 'study_combo') else ""
        if not selected_study:
            return
        self.load_pattern(selected_study, restart_timer=True)

    def load_pattern(self, study_type, restart_timer=False):
        global SEARCH_PATTERN_STEPS
        if not study_type:
            return
            
        if study_type in SEARCH_PATTERN_STEPS:
            self.current_steps = self._materialize_linked_steps(SEARCH_PATTERN_STEPS.get(study_type, []))
        elif study_type in SEARCH_PATTERNS:
            pattern_text = SEARCH_PATTERNS[study_type]
            self.current_steps = self._materialize_linked_steps(self.parse_search_pattern_text(pattern_text))
        else:
            self.current_steps = []

        if self.current_steps is not None:
            label_text = f"{study_type}"
            
            self.current_step_index = 0
            self.current_loaded_study = study_type
            self.study_label.config(text=label_text, foreground="#ffffff")
            self.update_step_counter()
            self.display_current_step()
            
            # Automatically start/reset timer when pattern is loaded (unless restart_timer=False)
            if restart_timer:
                self.start_time = time.time()
                self.elapsed_time = 0
                self.timer_running = True
                self.update_timer()

    def update_step_counter(self):
        steps_len = len(self.current_steps)
        if self.current_step_index < steps_len:
            if steps_len > 0:
                self.step_counter_label.config(text=f"Step {self.current_step_index + 1} of {steps_len}", foreground="#aaaaaa")
            else:
                self.step_counter_label.config(text="")
        else:
            self.step_counter_label.config(text="Finished", foreground="#aaaaaa")

    # ---- Step text tag configuration ----
    def _configure_step_text_tags(self):
        """Configure all step_text tags with fixed font sizes."""
        self.step_text.configure(font=("Courier", 20))
        self.step_text.tag_configure("step_name", font=("Courier", 32, "bold"), foreground="#00ddff", justify='center')
        self.step_text.tag_configure("detail_label", font=("Courier", 24, "bold"), foreground="#ffdd00")
        self.step_text.tag_configure("detail_content", font=("Courier", 20), foreground="#dddddd")
        self.step_text.tag_configure('bold', font=("Courier", 20, "bold"))
        self.step_text.tag_configure('red', foreground="#ff4d4f")
        self.step_text.tag_configure('green', foreground="#52c41a")

    # ---- Click-to-open helpers ----
    def _on_step_text_click(self, event):
        """Handle clicks on images (open in Preview) and URLs (open in browser)."""
        widget = event.widget
        index = widget.index(f"@{event.x},{event.y}")
        candidate_indices = [index]
        try:
            candidate_indices.append(widget.index(f"{index} -1c"))
            candidate_indices.append(widget.index(f"{index} +1c"))
        except tk.TclError:
            pass

        # Check if the click landed on an image
        for name in widget.image_names():
            try:
                img_index = widget.index(name)
                if img_index in candidate_indices:
                    self._open_image_in_preview(widget, name)
                    return
            except tk.TclError:
                continue

        # Check if the click landed on a URL tag
        tags = widget.tag_names(index)
        for tag in tags:
            if tag.startswith('url_'):
                url = getattr(widget, '_url_map', {}).get(tag)
                if url:
                    webbrowser.open(url)
                return

    def _open_image_in_preview(self, text_widget, image_name):
        """Save the full-resolution image to a temp file and open it in Preview."""
        raw_data = self._raw_image_data.get(text_widget, {}).get(image_name)
        if not raw_data:
            return
        try:
            tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
            tmp.write(raw_data)
            tmp.close()
            subprocess.Popen(['open', tmp.name])
        except Exception as e:
            messagebox.showerror("Image Error", f"Could not open image: {e}")

    def display_current_step(self):
        steps_len = len(self.current_steps)
        if self.current_step_index == steps_len and self.timer_running:
            self.stop_timer()

        self.step_text.config(state='normal')
        self.step_text.delete(1.0, tk.END)

        title_display = ""

        if not self.current_steps:
            self.step_text.insert(tk.END, "No steps loaded.", "detail_content")
        elif self.current_step_index < steps_len:
            step = self.current_steps[self.current_step_index]
            title_display = step.get('step_title', 'Untitled Step')

            rich_content = step.get('rich_content', [])
            if rich_content:
                self._render_rich_content(self.step_text, rich_content, clear=False)
                self.step_text.insert(tk.END, "\n\n", "detail_content")
            else:
                content = step.get('how_to_view_this_region', '')
                if content:
                    self.step_text.insert(tk.END, f"{content}\n\n", "detail_content")
        else:
            title_display = "FINISHED!"
            self.step_text.insert(tk.END, "Make sure to reread the report and look for errors.", "detail_content")

        if hasattr(self, 'step_title_label'):
            self.step_title_label.config(text=title_display)

        self.step_text.config(state='disabled')
        self.update_step_counter()

    def prev_step(self):
        if self.current_step_index > 0:
            self.current_step_index -= 1
            self.display_current_step()

    def next_step(self):
        steps_len = len(self.current_steps)
        if self.current_step_index < steps_len:
            self.current_step_index += 1
            self.display_current_step()

    def cancel_study(self):
        """Stop the timer and record the current study and elapsed time to `study_times.csv`."""
        # If timer not running and no elapsed time, nothing to record
        if not self.timer_running and (not getattr(self, 'elapsed_time', 0)):
            messagebox.showinfo("Timer", "No active timer to cancel.")
            return

        # Stop timer and capture elapsed seconds
        try:
            self.stop_timer()
        except Exception:
            pass

        elapsed = int(getattr(self, 'elapsed_time', 0) or 0)
        # prefer the canonical key, otherwise show the visible study label
        study = getattr(self, 'current_loaded_study', None) or (self.study_label.cget('text') if getattr(self, 'study_label', None) else 'Unknown')

        try:
            self.record_study_time(study, elapsed)
            messagebox.showinfo("Recorded", f"Recorded {self._format_seconds(elapsed)} for '{study}'")
        except Exception as e:
            messagebox.showerror("Record Error", f"Failed to record study time: {e}")

    def record_study_time(self, study_label: str, seconds: int):
        """Append a study timing record to `study_times.csv` and refresh the Study Log tab."""
        csv_file = get_data_path('study_times.csv')
        now = datetime.now()
        timestamp = now.isoformat(sep=' ', timespec='seconds')
        date_str = now.strftime('%Y-%m-%d')
        duration = self._format_seconds(seconds)
        try:
            # Try to append via pandas if available; include rvu (may be None)
            row = {
                'timestamp': timestamp,
                'date': date_str,
                'study': study_label,
                'seconds': int(seconds),
                'duration': duration,
                'rvu': None
            }
            if os.path.exists(csv_file):
                try:
                    df = pd.read_csv(csv_file)
                except pd.errors.EmptyDataError:
                    df = pd.DataFrame(columns=['timestamp','date','study','seconds','duration','rvu'])
                
                # Use loc to append the row instead of concat to avoid FutureWarning
                df.loc[len(df)] = row
            else:
                df = pd.DataFrame([row])
            # ensure rvu column exists
            if 'rvu' not in df.columns:
                df['rvu'] = None
            # Ensure directory exists before writing
            ensure_parent_dir(csv_file)
            with open(csv_file, 'w', newline='', encoding='utf-8') as f:
                df.to_csv(f, index=False)
            # Refresh UI
            try:
                self.refresh_times_tab()
                self.update_rvu_total()
            except Exception:
                pass

            # If we didn't find an RVU for this study, prompt user to select one from RVUS.xlsx
            try:
                if row.get('rvu') is None:
                    selected = self._prompt_select_rvu(study_label)
                    if selected is not None:
                        # update all rows for this study with missing rvu
                        try:
                            df.loc[(df['study'] == study_label) & (df['rvu'].isnull()), 'rvu'] = float(selected)
                            ensure_parent_dir(csv_file)
                            with open(csv_file, 'w', newline='', encoding='utf-8') as f:
                                df.to_csv(f, index=False)
                            # refresh UI and totals
                            try:
                                self.refresh_times_tab()
                                self.update_rvu_total()
                            except Exception:
                                pass
                        except Exception:
                            pass
            except Exception:
                pass
        except Exception:
            # Fallback minimal CSV append without rvu
            try:
                ensure_parent_dir(csv_file)
                header = not os.path.exists(csv_file)
                with open(csv_file, 'a', encoding='utf-8', newline='') as f:
                    if header:
                        f.write('timestamp,date,study,seconds,duration,rvu\n')
                    f.write(f"{timestamp},{date_str},\"{study_label}\",{int(seconds)},{duration},\n")
                try:
                    self.refresh_times_tab()
                    self.update_rvu_total()
                except Exception:
                    pass
            except Exception:
                raise

    def _format_seconds(self, secs: int) -> str:
        hours, remainder = divmod(int(secs), 3600)
        mins, secs = divmod(remainder, 60)
        if hours > 0:
            return f"{hours}h {mins:02d}m {secs:02d}s"
        else:
            return f"{mins}m {secs:02d}s"

    def update_rvu_total(self):
        """Compute today's RVU total from `study_times.csv` and update `self.rvu_label`."""
        csv_file = self.get_study_times_csv_path()
        total = 0.0
        count = 0
        if os.path.exists(csv_file):
            try:
                df = pd.read_csv(csv_file)
                if 'rvu' in df.columns:
                    try:
                        df['rvu_numeric'] = pd.to_numeric(df['rvu'], errors='coerce')
                        today = datetime.now().date()
                        df['date_parsed'] = pd.to_datetime(df['date'], errors='coerce').dt.date
                        todays = df[df['date_parsed'] == today]
                        total = float(todays['rvu_numeric'].sum(skipna=True)) if not todays.empty else 0.0
                        count = len(todays)
                    except Exception:
                        total = 0.0
                        count = 0
            except Exception:
                total = 0.0
                count = 0

        # Update label text
        try:
            self.rvu_label.config(text=f"RVUs today: {total:.2f} ({count} studies)")
        except Exception:
            pass

    def setup_calculations_tab(self):
        outer = ttk.Frame(self.calc_tab)
        outer.pack(fill='both', expand=True, padx=20, pady=20)

        # Calculator selector
        selector_frame = ttk.Frame(outer)
        selector_frame.pack(fill='x', pady=(0, 20))
        ttk.Label(selector_frame, text="Calculator:", font=("Helvetica", 13, "bold")).pack(side='left', padx=(0, 10))
        self.calc_choice = tk.StringVar(value="Estimated Volume")
        calc_combo = ttk.Combobox(
            selector_frame,
            textvariable=self.calc_choice,
            values=["Estimated Volume", "Percent Narrowing", "LFT Analysis", "DLP Multi-Scan to mGy"],
            state="readonly",
            width=30,
            font=("Helvetica", 12),
        )
        calc_combo.pack(side='left')
        calc_combo.bind("<<ComboboxSelected>>", lambda e: self._show_calculator())

        # Container that swaps content
        self.calc_content_frame = ttk.Frame(outer)
        self.calc_content_frame.pack(fill='both', expand=True)

        self._show_calculator()

    def _show_calculator(self):
        for widget in self.calc_content_frame.winfo_children():
            widget.destroy()

        choice = self.calc_choice.get()
        if choice == "Estimated Volume":
            self._build_volume_calculator(self.calc_content_frame)
        elif choice == "Percent Narrowing":
            self._build_narrowing_calculator(self.calc_content_frame)
        elif choice == "LFT Analysis":
            self._build_lft_calculator(self.calc_content_frame)
        elif choice == "DLP Multi-Scan to mGy":
            self._build_dlp_converter(self.calc_content_frame)

    def _build_volume_calculator(self, parent):
        frame = ttk.LabelFrame(parent, text="Estimated Volume  (0.523 × Height × Width × Length)", padding=16)
        frame.pack(fill='x', pady=(0, 16))

        fields = [("Height (cm):", "vol_height"), ("Width (cm):", "vol_width"), ("Length (cm):", "vol_length")]
        self._vol_vars = {}
        for label_text, key in fields:
            row = ttk.Frame(frame)
            row.pack(fill='x', pady=4)
            ttk.Label(row, text=label_text, width=16, anchor='w', font=("Helvetica", 12)).pack(side='left')
            var = tk.StringVar()
            self._vol_vars[key] = var
            entry = ttk.Entry(row, textvariable=var, width=14, font=("Helvetica", 12))
            entry.pack(side='left')
            entry.bind("<Return>", lambda e: self._calc_volume())

        btn_row = ttk.Frame(frame)
        btn_row.pack(fill='x', pady=(10, 0))
        ttk.Button(btn_row, text="Calculate", command=self._calc_volume).pack(side='left')
        ttk.Button(btn_row, text="Clear", command=lambda: [v.set("") for v in self._vol_vars.values()] or self._vol_result_var.set("")).pack(side='left', padx=(8, 0))

        self._vol_result_var = tk.StringVar()
        result_frame = ttk.Frame(parent)
        result_frame.pack(fill='x', pady=(4, 0))
        ttk.Label(result_frame, text="Result:", font=("Helvetica", 12, "bold")).pack(side='left', padx=(0, 8))
        ttk.Label(result_frame, textvariable=self._vol_result_var, font=("Helvetica", 13), foreground="#1a6e2e").pack(side='left')

    def _calc_volume(self):
        try:
            h = float(self._vol_vars["vol_height"].get())
            w = float(self._vol_vars["vol_width"].get())
            l = float(self._vol_vars["vol_length"].get())
            result = 0.523 * h * w * l
            self._vol_result_var.set(f"{result:.2f} cm³")
        except ValueError:
            self._vol_result_var.set("Please enter valid numbers for all fields.")

    def _build_narrowing_calculator(self, parent):
        frame = ttk.LabelFrame(parent, text="Percent Narrowing  ((Distal − Proximal) / Distal × 100)", padding=16)
        frame.pack(fill='x', pady=(0, 16))

        fields = [("Distal (mm):", "narrow_distal"), ("Proximal (mm):", "narrow_proximal")]
        self._narrow_vars = {}
        for label_text, key in fields:
            row = ttk.Frame(frame)
            row.pack(fill='x', pady=4)
            ttk.Label(row, text=label_text, width=16, anchor='w', font=("Helvetica", 12)).pack(side='left')
            var = tk.StringVar()
            self._narrow_vars[key] = var
            entry = ttk.Entry(row, textvariable=var, width=14, font=("Helvetica", 12))
            entry.pack(side='left')
            entry.bind("<Return>", lambda e: self._calc_narrowing())

        btn_row = ttk.Frame(frame)
        btn_row.pack(fill='x', pady=(10, 0))
        ttk.Button(btn_row, text="Calculate", command=self._calc_narrowing).pack(side='left')
        ttk.Button(btn_row, text="Clear", command=lambda: [v.set("") for v in self._narrow_vars.values()] or self._narrow_result_var.set("")).pack(side='left', padx=(8, 0))

        self._narrow_result_var = tk.StringVar()
        result_frame = ttk.Frame(parent)
        result_frame.pack(fill='x', pady=(4, 0))
        ttk.Label(result_frame, text="Result:", font=("Helvetica", 12, "bold")).pack(side='left', padx=(0, 8))
        ttk.Label(result_frame, textvariable=self._narrow_result_var, font=("Helvetica", 13), foreground="#1a6e2e").pack(side='left')

    def _calc_narrowing(self):
        try:
            distal = float(self._narrow_vars["narrow_distal"].get())
            proximal = float(self._narrow_vars["narrow_proximal"].get())
            if distal == 0:
                self._narrow_result_var.set("Distal value cannot be zero.")
                return
            result = (distal - proximal) / distal * 100
            self._narrow_result_var.set(f"{result:.1f}%")
        except ValueError:
            self._narrow_result_var.set("Please enter valid numbers for both fields.")

    def _build_lft_calculator(self, parent):
        frame = ttk.LabelFrame(parent, text="LFT Analysis", padding=16)
        frame.pack(fill='x', pady=(0, 16))

        intro = (
            "Enter AST, ALT, alkaline phosphatase, and bilirubin values to classify the pattern of injury. "
            "The analyzer uses ALT/alk phos ratios relative to the listed upper limits of normal."
        )
        ttk.Label(frame, text=intro, font=("Helvetica", 11), wraplength=760, justify='left').pack(fill='x', pady=(0, 12))

        self._lft_vars = {
            "ast": tk.StringVar(),
            "alt": tk.StringVar(),
            "alp": tk.StringVar(),
            "tbili": tk.StringVar(),
            "dbili": tk.StringVar(),
            "ast_uln": tk.StringVar(value="40"),
            "alt_uln": tk.StringVar(value="40"),
            "alp_uln": tk.StringVar(value="120"),
            "tbili_uln": tk.StringVar(value="1.2"),
        }

        input_fields = [
            ("AST (U/L):", "ast"),
            ("ALT (U/L):", "alt"),
            ("Alk Phos (U/L):", "alp"),
            ("Total bilirubin (mg/dL):", "tbili"),
            ("Direct bilirubin (mg/dL, optional):", "dbili"),
        ]
        for label_text, key in input_fields:
            row = ttk.Frame(frame)
            row.pack(fill='x', pady=4)
            ttk.Label(row, text=label_text, width=28, anchor='w', font=("Helvetica", 12)).pack(side='left')
            entry = ttk.Entry(row, textvariable=self._lft_vars[key], width=14, font=("Helvetica", 12))
            entry.pack(side='left')
            entry.bind("<Return>", lambda e: self._calc_lft_analysis())

        uln_frame = ttk.LabelFrame(frame, text="Upper Limits of Normal", padding=12)
        uln_frame.pack(fill='x', pady=(14, 0))
        uln_fields = [
            ("AST ULN:", "ast_uln"),
            ("ALT ULN:", "alt_uln"),
            ("Alk Phos ULN:", "alp_uln"),
            ("Total bili ULN:", "tbili_uln"),
        ]
        for idx, (label_text, key) in enumerate(uln_fields):
            row = idx // 2
            col = (idx % 2) * 2
            ttk.Label(uln_frame, text=label_text, font=("Helvetica", 11)).grid(row=row, column=col, sticky='w', padx=(0, 8), pady=4)
            entry = ttk.Entry(uln_frame, textvariable=self._lft_vars[key], width=10, font=("Helvetica", 11))
            entry.grid(row=row, column=col + 1, sticky='w', padx=(0, 20), pady=4)
            entry.bind("<Return>", lambda e: self._calc_lft_analysis())

        btn_row = ttk.Frame(frame)
        btn_row.pack(fill='x', pady=(14, 0))
        ttk.Button(btn_row, text="Analyze", command=self._calc_lft_analysis).pack(side='left')
        ttk.Button(btn_row, text="Clear", command=self._clear_lft_analysis).pack(side='left', padx=(8, 0))

        self._lft_pattern_var = tk.StringVar()
        self._lft_ratio_var = tk.StringVar()
        self._lft_interpretation_var = tk.StringVar()

        result_frame = ttk.LabelFrame(parent, text="Interpretation", padding=16)
        result_frame.pack(fill='both', expand=True)
        ttk.Label(result_frame, textvariable=self._lft_pattern_var, font=("Helvetica", 13, "bold"), foreground="#1a6e2e").pack(anchor='w')
        ttk.Label(result_frame, textvariable=self._lft_ratio_var, font=("Helvetica", 11)).pack(anchor='w', pady=(6, 10))
        ttk.Label(
            result_frame,
            textvariable=self._lft_interpretation_var,
            font=("Helvetica", 11),
            justify='left',
            wraplength=760,
        ).pack(fill='x', anchor='w')

    def _clear_lft_analysis(self):
        if not hasattr(self, '_lft_vars'):
            return

        for key in ["ast", "alt", "alp", "tbili", "dbili"]:
            self._lft_vars[key].set("")

        self._lft_vars["ast_uln"].set("40")
        self._lft_vars["alt_uln"].set("40")
        self._lft_vars["alp_uln"].set("120")
        self._lft_vars["tbili_uln"].set("1.2")
        self._lft_pattern_var.set("")
        self._lft_ratio_var.set("")
        self._lft_interpretation_var.set("")

    def _calc_lft_analysis(self):
        try:
            ast = float(self._lft_vars["ast"].get())
            alt = float(self._lft_vars["alt"].get())
            alp = float(self._lft_vars["alp"].get())
            tbili = float(self._lft_vars["tbili"].get())
            dbili_text = self._lft_vars["dbili"].get().strip()
            dbili = float(dbili_text) if dbili_text else None
            ast_uln = float(self._lft_vars["ast_uln"].get())
            alt_uln = float(self._lft_vars["alt_uln"].get())
            alp_uln = float(self._lft_vars["alp_uln"].get())
            tbili_uln = float(self._lft_vars["tbili_uln"].get())
        except ValueError:
            self._lft_pattern_var.set("Please enter valid numbers for the LFT fields.")
            self._lft_ratio_var.set("")
            self._lft_interpretation_var.set("")
            return

        if min(ast_uln, alt_uln, alp_uln, tbili_uln) <= 0:
            self._lft_pattern_var.set("Upper limits of normal must be greater than zero.")
            self._lft_ratio_var.set("")
            self._lft_interpretation_var.set("")
            return

        if min(ast, alt, alp, tbili) < 0 or (dbili is not None and dbili < 0):
            self._lft_pattern_var.set("LFT values cannot be negative.")
            self._lft_ratio_var.set("")
            self._lft_interpretation_var.set("")
            return

        ast_ratio = ast / ast_uln
        alt_ratio = alt / alt_uln
        alp_ratio = alp / alp_uln
        tbili_ratio = tbili / tbili_uln
        r_factor = alt_ratio / alp_ratio if alp_ratio > 0 else float('inf')

        if alt_ratio <= 1 and alp_ratio <= 1 and tbili_ratio <= 1:
            pattern = "No significant LFT elevation pattern"
            interpretation_lines = [
                "AST, ALT, alk phos, and bilirubin are not above the entered upper limits of normal.",
                "Correlate with symptoms and trend over time if clinical concern remains high.",
            ]
        elif alt_ratio <= 1 and alp_ratio <= 1 and tbili_ratio > 1:
            pattern = "Isolated hyperbilirubinemia"
            interpretation_lines = [
                "Bilirubin is elevated without a clear hepatocellular or cholestatic enzyme pattern.",
            ]
            if dbili is not None and tbili > 0:
                direct_fraction = dbili / tbili
                if direct_fraction < 0.2:
                    interpretation_lines.append("Predominantly indirect bilirubin can suggest Gilbert syndrome or hemolysis.")
                elif direct_fraction > 0.5:
                    interpretation_lines.append("Predominantly direct bilirubin can suggest cholestasis or impaired hepatic excretion.")
            interpretation_lines.append("If bilirubin remains elevated, correlate with hemolysis labs and biliary imaging as appropriate.")
        else:
            if alt_ratio > 1 and alp_ratio > 1:
                if r_factor >= 5:
                    pattern = "Hepatocellular pattern"
                    interpretation_lines = [
                        "ALT elevation is dominant relative to alk phos, which fits a hepatocellular injury pattern.",
                        "Typical considerations include viral hepatitis, ischemic injury, toxin or medication-related hepatitis, and autoimmune hepatitis.",
                    ]
                elif r_factor <= 2:
                    pattern = "Cholestatic pattern"
                    interpretation_lines = [
                        "Alk phos elevation is dominant relative to ALT, which fits a cholestatic pattern.",
                        "This can suggest biliary obstruction, choledocholithiasis, PSC, PBC, infiltrative disease, or cholestatic drug injury.",
                    ]
                else:
                    pattern = "Mixed hepatocellular/cholestatic pattern"
                    interpretation_lines = [
                        "Both ALT and alk phos are elevated with an intermediate R factor, which fits a mixed injury pattern.",
                        "This can be seen with drug-induced liver injury, biliary disease with superimposed hepatitis, or evolving obstruction.",
                    ]
            elif alt_ratio > 1:
                pattern = "Predominantly hepatocellular pattern"
                interpretation_lines = [
                    "Transaminase elevation is greater than alk phos elevation, favoring hepatocellular injury.",
                    "Consider viral, ischemic, inflammatory, metabolic, or drug-related causes in the right clinical context.",
                ]
            else:
                pattern = "Predominantly cholestatic pattern"
                interpretation_lines = [
                    "Alk phos elevation exceeds the transaminase pattern, favoring cholestasis.",
                    "Consider biliary obstruction or hepatic cholestatic processes; if alk phos is isolated, confirm hepatic source with GGT or isoenzymes.",
                ]

            if tbili_ratio > 1:
                interpretation_lines.append("Concurrent bilirubin elevation suggests more significant cholestasis or reduced hepatic excretory function.")

        if alt > 0:
            ast_alt_ratio = ast / alt
            if ast > ast_uln or alt > alt_uln:
                if ast_alt_ratio >= 2:
                    interpretation_lines.append("AST:ALT ratio >= 2 can be seen with alcohol-associated liver injury, especially when AST and ALT are both elevated.")
                elif ast_alt_ratio > 1:
                    interpretation_lines.append("AST:ALT ratio > 1 can be seen with advanced fibrosis or cirrhosis, but is nonspecific.")
        else:
            ast_alt_ratio = None

        ratio_bits = [
            f"AST {ast_ratio:.1f}x ULN",
            f"ALT {alt_ratio:.1f}x ULN",
            f"Alk phos {alp_ratio:.1f}x ULN",
            f"Total bilirubin {tbili_ratio:.1f}x ULN",
        ]
        if alp_ratio > 0 and math.isfinite(r_factor):
            ratio_bits.append(f"R factor {r_factor:.2f}")
        if ast_alt_ratio is not None:
            ratio_bits.append(f"AST:ALT {ast_alt_ratio:.2f}")

        self._lft_pattern_var.set(pattern)
        self._lft_ratio_var.set(" | ".join(ratio_bits))
        self._lft_interpretation_var.set("\n".join(interpretation_lines))

    def _build_dlp_converter(self, parent):
        frame = ttk.LabelFrame(parent, text="DLP Multi-Scan to mGy & Deterministic Risk", padding=16)
        frame.pack(fill='x', pady=(0, 16))

        intro = (
            "Enter DLP per scan, number of scans, and typical scanned length. "
            "The primary output is cumulative absorbed dose (mGy, approximated as total DLP / scan length). "
            "An effective-dose context (mSv) is also shown using AAPM k-values."
        )
        ttk.Label(frame, text=intro, font=("Helvetica", 11), wraplength=760, justify='left').pack(fill='x', pady=(0, 12))

        # DLP input
        input_row = ttk.Frame(frame)
        input_row.pack(fill='x', pady=4)
        ttk.Label(input_row, text="DLP per scan (mGy·cm):", width=24, anchor='w', font=("Helvetica", 12)).pack(side='left')
        self._dlp_var = tk.StringVar()
        dlp_entry = ttk.Entry(input_row, textvariable=self._dlp_var, width=14, font=("Helvetica", 12))
        dlp_entry.pack(side='left')
        dlp_entry.bind("<Return>", lambda e: self._calc_dlp_conversion())

        scans_row = ttk.Frame(frame)
        scans_row.pack(fill='x', pady=4)
        ttk.Label(scans_row, text="Number of scans:", width=24, anchor='w', font=("Helvetica", 12)).pack(side='left')
        self._dlp_scans_var = tk.StringVar(value="1")
        scans_entry = ttk.Entry(scans_row, textvariable=self._dlp_scans_var, width=14, font=("Helvetica", 12))
        scans_entry.pack(side='left')
        scans_entry.bind("<Return>", lambda e: self._calc_dlp_conversion())

        length_row = ttk.Frame(frame)
        length_row.pack(fill='x', pady=4)
        ttk.Label(length_row, text="Scan length per scan (cm):", width=24, anchor='w', font=("Helvetica", 12)).pack(side='left')
        self._dlp_length_var = tk.StringVar(value="40")
        length_entry = ttk.Entry(length_row, textvariable=self._dlp_length_var, width=14, font=("Helvetica", 12))
        length_entry.pack(side='left')
        length_entry.bind("<Return>", lambda e: self._calc_dlp_conversion())

        # Scan type selection
        scan_row = ttk.Frame(frame)
        scan_row.pack(fill='x', pady=4)
        ttk.Label(scan_row, text="Body Region:", width=20, anchor='w', font=("Helvetica", 12)).pack(side='left')
        self._dlp_scan_type_var = tk.StringVar(value="Chest")
        scan_combo = ttk.Combobox(
            scan_row,
            textvariable=self._dlp_scan_type_var,
            values=["Head", "Neck", "Head and Neck", "Chest", "Abdomen and Pelvis", "Trunk"],
            state="readonly",
            width=20,
            font=("Helvetica", 12),
        )
        scan_combo.pack(side='left')

        # Patient age selection
        age_row = ttk.Frame(frame)
        age_row.pack(fill='x', pady=4)
        ttk.Label(age_row, text="Patient Age:", width=20, anchor='w', font=("Helvetica", 12)).pack(side='left')
        self._dlp_age_var = tk.StringVar(value="Adult")
        age_combo = ttk.Combobox(
            age_row,
            textvariable=self._dlp_age_var,
            values=["0 years (newborn)", "1 year old", "5 years old", "10 years old", "Adult"],
            state="readonly",
            width=20,
            font=("Helvetica", 12),
        )
        age_combo.pack(side='left')

        # Button row
        btn_row = ttk.Frame(frame)
        btn_row.pack(fill='x', pady=(10, 0))
        ttk.Button(btn_row, text="Calculate", command=self._calc_dlp_conversion).pack(side='left')
        ttk.Button(
            btn_row,
            text="Clear",
            command=lambda: [
                self._dlp_var.set(""),
                self._dlp_scans_var.set("1"),
                self._dlp_length_var.set("40"),
                self._dlp_result_var.set(""),
                self._dlp_cancer_var.set(""),
            ],
        ).pack(side='left', padx=(8, 0))

        # Results
        result_frame = ttk.LabelFrame(parent, text="Results", padding=16)
        result_frame.pack(fill='both', expand=True)

        self._dlp_result_var = tk.StringVar()
        self._dlp_cancer_var = tk.StringVar()

        ttk.Label(result_frame, text="Cumulative Dose (mGy):", font=("Helvetica", 12, "bold")).pack(anchor='w')
        ttk.Label(result_frame, textvariable=self._dlp_result_var, font=("Helvetica", 13), foreground="#1a6e2e").pack(anchor='w', pady=(4, 12))

        ttk.Label(result_frame, text="Deterministic Effect Likelihood:", font=("Helvetica", 12, "bold")).pack(anchor='w')
        ttk.Label(result_frame, textvariable=self._dlp_cancer_var, font=("Helvetica", 13), foreground="#1a6e2e").pack(anchor='w')

    def _calc_dlp_conversion(self):
        # AAPM k-values (mSv per mGy·cm)
        k_values = {
            "Head and Neck": {"0": 0.013, "1": 0.0085, "5": 0.0057, "10": 0.0042, "Adult": 0.0031},
            "Head": {"0": 0.011, "1": 0.0067, "5": 0.0040, "10": 0.0032, "Adult": 0.0021},
            "Neck": {"0": 0.017, "1": 0.012, "5": 0.011, "10": 0.0079, "Adult": 0.0059},
            "Chest": {"0": 0.039, "1": 0.026, "5": 0.018, "10": 0.013, "Adult": 0.014},
            "Abdomen and Pelvis": {"0": 0.049, "1": 0.030, "5": 0.020, "10": 0.015, "Adult": 0.015},
            "Trunk": {"0": 0.044, "1": 0.028, "5": 0.019, "10": 0.014, "Adult": 0.015},
        }

        def deterministic_message(absorbed_dose_mgy):
            if absorbed_dose_mgy < 500:
                return "Very low likelihood of deterministic injury (erythema/alopecia/sterility not expected)."
            if absorbed_dose_mgy < 2000:
                return "Low likelihood of deterministic injury; generally below common skin injury thresholds."
            if absorbed_dose_mgy < 3000:
                return "Moderate likelihood zone: transient skin erythema is possible; temporary epilation may occur."
            if absorbed_dose_mgy < 7000:
                return "Higher likelihood zone: transient erythema and alopecia more likely; temporary sterility possible with significant gonadal exposure."
            return "Very high risk zone: significant skin injury and prolonged alopecia are possible; urgent dose review advised."
        
        try:
            dlp_per_scan = float(self._dlp_var.get())
            scans = int(float(self._dlp_scans_var.get()))
            scan_length_cm = float(self._dlp_length_var.get())
            scan_type = self._dlp_scan_type_var.get()
            age_str = self._dlp_age_var.get()

            if dlp_per_scan < 0 or scans < 1 or scan_length_cm <= 0:
                raise ValueError
            
            # Extract age key from the display string
            age_key = "Adult"
            if "0 years" in age_str:
                age_key = "0"
            elif "1 year" in age_str:
                age_key = "1"
            elif "5 years" in age_str:
                age_key = "5"
            elif "10 years" in age_str:
                age_key = "10"
            
            # Get the k-value for this body region and age
            factor = k_values.get(scan_type, {}).get(age_key, 0.014)
            
            total_dlp = dlp_per_scan * scans
            absorbed_dose_mgy = total_dlp / scan_length_cm
            effective_dose_msv = total_dlp * factor

            self._dlp_result_var.set(
                f"{total_dlp:.1f} mGy·cm total ({dlp_per_scan:.1f} × {scans}) ÷ {scan_length_cm:.1f} cm = {absorbed_dose_mgy:.1f} mGy"
            )
            self._dlp_cancer_var.set(
                f"{deterministic_message(absorbed_dose_mgy)} Effective-dose context: {effective_dose_msv:.2f} mSv (k={factor})."
            )
        except ValueError:
            self._dlp_result_var.set("Please enter valid values for DLP, scan count (>=1), and scan length (>0).")
            self._dlp_cancer_var.set("")

    def setup_times_tab(self):
        # Build the Study Log UI: filter controls + treeview
        frame = ttk.Frame(self.times_tab)
        frame.pack(fill='both', expand=True, padx=12, pady=12)

        ctrl_row = ttk.Frame(frame)
        ctrl_row.pack(fill='x', pady=(0,6))
        ttk.Label(ctrl_row, text="Filter:").pack(side='left')
        self.times_filter_var = tk.StringVar(value='Today')
        self.times_filter_combo = ttk.Combobox(ctrl_row, values=['All','Today','Last 7 Days'], state='readonly', width=16, textvariable=self.times_filter_var)
        self.times_filter_combo.pack(side='left', padx=(6,8))
        self.times_filter_combo.bind('<<ComboboxSelected>>', lambda e: self.refresh_times_tab())
        ttk.Button(ctrl_row, text='Refresh', command=self.refresh_times_tab).pack(side='left', padx=(4,0))

        cols = ('study', 'duration', 'rvu', 'timestamp')
        self.times_tree = ttk.Treeview(frame, columns=cols, show='headings')
        self.times_tree.heading('study', text='Study', command=lambda: self._sort_times('study'))
        self.times_tree.heading('duration', text='Duration', command=lambda: self._sort_times('duration'))
        self.times_tree.heading('rvu', text='RVU', command=lambda: self._sort_times('rvu'))
        self.times_tree.heading('timestamp', text='Timestamp', command=lambda: self._sort_times('timestamp'))
        self.times_tree.column('study', width=420)
        self.times_tree.column('duration', width=120)
        self.times_tree.column('rvu', width=80, anchor='center')
        self.times_tree.column('timestamp', width=180)
        self.times_tree.pack(fill='both', expand=True, pady=(0, 6))

        # Add button frame with remove button
        btn_frame = ttk.Frame(frame)
        btn_frame.pack(fill='x')
        ttk.Button(btn_frame, text='Remove Selected', command=self._remove_selected_study).pack(side='left')

        # initialize sort state
        self._times_sort_state = {'col': 'timestamp', 'reverse': True}

        # Load existing records
        self.refresh_times_tab()

    def refresh_times_tab(self):
        """Refresh the study times table."""
        try:
            # Clear the tree
            for item in self.times_tree.get_children():
                self.times_tree.delete(item)
            
            # Load study times from CSV
            csv_file = self.get_study_times_csv_path()
            
            if not os.path.exists(csv_file):
                # Create empty CSV with headers
                df = pd.DataFrame(columns=['timestamp','date','study','seconds','duration','rvu'])
                try:
                    ensure_parent_dir(csv_file)
                    df.to_csv(csv_file, index=False)
                except Exception as e:
                    print(f"Error creating study_times.csv: {e}")
                return
            
            try:
                df = pd.read_csv(csv_file)
            except (pd.errors.EmptyDataError, pd.errors.ParserError) as e:
                # If CSV is corrupted or empty, recreate it with headers
                print(f"Warning: Corrupted or invalid CSV, recreating: {e}")
                df = pd.DataFrame(columns=['timestamp','date','study','seconds','duration','rvu'])
                try:
                    ensure_parent_dir(csv_file)
                    df.to_csv(csv_file, index=False)
                except Exception as write_e:
                    print(f"Error recreating study_times.csv: {write_e}")
                return
            except Exception as e:
                print(f"Unexpected error reading CSV: {e}")
                return
            
            if df.empty:
                return
            
            # Apply filter if needed
            filter_val = self.times_filter_combo.get() if hasattr(self, 'times_filter_combo') else "All"
            if filter_val == "Today":
                # Filter for today's date
                today = datetime.now().strftime('%Y-%m-%d')
                df = df[df['date'] == today]
            elif filter_val == "Last 7 Days":
                # Filter for last 7 days
                cutoff_date = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
                df = df[df['date'] >= cutoff_date]
            # If "All", no filtering needed
            
            # Sort by timestamp (most recent first) or by selected column
            sort_col = self._times_sort_state.get('col', 'timestamp')
            reverse = self._times_sort_state.get('reverse', True)
            
            if sort_col in df.columns:
                df = df.sort_values(by=sort_col, ascending=not reverse)
            
            # Insert into tree
            for _, row in df.iterrows():
                # Format RVU value
                rvu_val = row.get('rvu', '')
                if pd.notna(rvu_val) and rvu_val != '':
                    try:
                        rvu_val = float(rvu_val)
                    except:
                        rvu_val = ''
                else:
                    rvu_val = ''
                
                values = (
                    row.get('study', ''),
                    row.get('duration', row.get('seconds', 0)),
                    rvu_val,
                    row.get('timestamp', '')
                )
                self.times_tree.insert('', 'end', values=values)
        except Exception as e:
            print(f"Error refreshing times tab: {e}")

    def _remove_selected_study(self):
        """Remove the selected study from the study log and update the CSV file."""
        selection = self.times_tree.selection()
        if not selection:
            messagebox.showwarning("No Selection", "Please select a study entry to remove.")
            return
        
        # Confirm deletion
        if not messagebox.askyesno("Confirm Removal", "Are you sure you want to remove this study entry?"):
            return
        
        csv_file = self.get_study_times_csv_path()
        if not os.path.exists(csv_file):
            messagebox.showerror("Error", "Study times file not found.")
            return
        
        try:
            # Load the CSV
            df = pd.read_csv(csv_file)
            
            # Get the selected item's values
            item = selection[0]
            values = self.times_tree.item(item, 'values')
            
            if len(values) < 4:
                messagebox.showerror("Error", "Invalid study entry selected.")
                return
            
            study_name = values[0]
            timestamp = values[3]
            
            # Find and remove the matching row from dataframe
            # Match both study and timestamp to ensure we delete the correct entry
            mask = (df['study'] == study_name) & (df['timestamp'] == timestamp)
            
            if mask.sum() == 0:
                messagebox.showerror("Error", "Could not find matching entry in CSV file.")
                return
            
            # Remove the row
            df = df[~mask]
            
            # Save back to CSV
            df.to_csv(csv_file, index=False)
            
            # Refresh the display
            self.refresh_times_tab()
            
            # Update RVU total
            self.update_rvu_total()
            
            messagebox.showinfo("Success", "Study entry removed successfully.")
            
        except Exception as e:
            messagebox.showerror("Error", f"Failed to remove study entry: {e}")

    def _get_historical_rvus_for_study(self, study_label: str) -> Dict[float, int]:
        """Get a count of how many times each RVU value has been used for a given study.
        Returns a dict mapping RVU value -> count.
        """
        csv_file = self.get_study_times_csv_path()
        if not os.path.exists(csv_file):
            return {}
        
        try:
            df = pd.read_csv(csv_file)
            if 'study' not in df.columns or 'rvu' not in df.columns:
                return {}
            
            # Filter for this study
            study_df = df[df['study'] == study_label]
            
            # Count RVU occurrences
            rvu_counts = {}
            for rvu_val in study_df['rvu'].dropna():
                try:
                    rvu_float = float(rvu_val)
                    rvu_counts[rvu_float] = rvu_counts.get(rvu_float, 0) + 1
                except:
                    pass
            
            return rvu_counts
        except Exception as e:
            print(f"Error reading historical RVUs: {e}")
            return {}

    def _rank_rvu_rows(self, rvudf, study_label: str, desc_col: str, cat_col: str, 
                       historical_rvus: Dict[float, int]) -> List[int]:
        """Rank RVU rows by relevance to study_label using semantic matching and historical usage.
        Returns a list of row indices sorted by relevance (most relevant first).
        """
        if len(rvudf) == 0:
            return []
        
        # Build text corpus for semantic matching
        corpus = {}
        for idx, row in rvudf.iterrows():
            # Combine description and category for matching
            text_parts = []
            if desc_col and pd.notna(row.get(desc_col)):
                text_parts.append(str(row.get(desc_col)))
            if cat_col and pd.notna(row.get(cat_col)):
                text_parts.append(str(row.get(cat_col)))
            corpus[idx] = ' '.join(text_parts)
        
        # Calculate semantic similarity scores
        scores = []
        
        # Try using SemanticMatcher for semantic similarity
        try:
            matcher = SemanticMatcher(corpus, openai_client=self.openai_client if hasattr(self, 'openai_client') else None, 
                                     openai_api_key=self.openai_api_key if hasattr(self, 'openai_api_key') else "")
            
            # Get top matches
            matches = matcher.find_best(study_label, top_k=len(rvudf))
            
            # Create score dict from matches (higher is better)
            semantic_scores = {}
            for rank, (idx, score) in enumerate(matches):
                # Convert rank to score (0 = best, higher = worse)
                semantic_scores[idx] = 1.0 / (rank + 1.0)
        except Exception as e:
            print(f"Semantic matching error: {e}")
            # Fallback to simple text similarity
            semantic_scores = {}
            study_lower = study_label.lower()
            for idx, text in corpus.items():
                text_lower = text.lower()
                # Simple word overlap score
                study_words = set(study_lower.split())
                text_words = set(text_lower.split())
                overlap = len(study_words & text_words)
                semantic_scores[idx] = overlap
        
        # Combine semantic score with historical usage
        for idx in range(len(rvudf)):
            row = rvudf.iloc[idx]
            
            # Get semantic score
            semantic_score = semantic_scores.get(idx, 0.0)
            
            # Get historical usage score
            historical_score = 0.0
            if 'rvu' in rvudf.columns:
                try:
                    rvu_val = float(row['rvu'])
                    historical_score = historical_rvus.get(rvu_val, 0) * 10.0  # Weight historical usage heavily
                except:
                    pass
            
            # Combined score: historical usage is weighted more heavily
            combined_score = historical_score + semantic_score
            scores.append((idx, combined_score))
        
        # Sort by combined score (descending)
        scores.sort(key=lambda x: x[1], reverse=True)
        
        return [idx for idx, _ in scores]

    def _prompt_select_rvu(self, study_label: str):
        """Prompt the user to select an RVU value from `RVUS.xlsx` for the given study_label.
        Returns the selected numeric RVU value or None if cancelled.
        """
        xlsx_names = ['RVUS.xlsx','rvus.xlsx','RVU.xlsx','rvu.xlsx']
        xlsx_path = None
        for n in xlsx_names:
            full_path = get_resource_path(n)
            if os.path.exists(full_path):
                xlsx_path = full_path
                break
        if xlsx_path is None:
            messagebox.showwarning("RVU File Missing", "RVUS.xlsx not found in the application folder. Please place RVUS.xlsx in the app directory to select RVUs.")
            return None

        try:
            rvudf = pd.read_excel(xlsx_path)
        except Exception as e:
            messagebox.showerror("RVU Load Error", f"Failed to load {xlsx_path}: {e}")
            return None

        # Detect useful columns: description, category, and rvu
        rvu_col = None
        desc_col = None
        cat_col = None
        col_names = [str(c) for c in rvudf.columns]
        # rvu column
        for c in col_names:
            if 'rvu' in c.lower():
                rvu_col = c
                break
        # description-like column
        for c in col_names:
            if c == rvu_col:
                continue
            low = c.lower()
            if any(k in low for k in ('description','desc','procedure','name','desc.')):
                desc_col = c
                break
        # category-like column
        for c in col_names:
            if c in (rvu_col, desc_col):
                continue
            low = c.lower()
            if any(k in low for k in ('category','cat','type','group','class')):
                cat_col = c
                break

        # Get historical RVU usage for this study from study_times.csv
        historical_rvus = self._get_historical_rvus_for_study(study_label)
        
        # Sort rows by relevance: semantic similarity + historical usage
        sorted_indices = self._rank_rvu_rows(rvudf, study_label, desc_col, cat_col, historical_rvus)

        # Create popup for selection
        sel = {'value': None}

        popup = tk.Toplevel(self.root)
        popup.title(f"Select RVU for: {study_label}")
        popup.geometry('700x500')
        ttk.Label(popup, text=f"Select RVU row for study: {study_label}").pack(pady=6)

        search_var = tk.StringVar()
        search_row = ttk.Frame(popup)
        search_row.pack(fill='x', padx=6)
        ttk.Label(search_row, text='Search:').pack(side='left')
        search_entry = ttk.Entry(search_row, textvariable=search_var)
        search_entry.pack(side='left', fill='x', expand=True, padx=(6,6))

        # Choose columns to display: Description, Category, RVU (fall back to available columns)
        display_cols = []
        if desc_col:
            display_cols.append(('description', desc_col))
        if cat_col:
            display_cols.append(('category', cat_col))
        if rvu_col:
            display_cols.append(('rvu', rvu_col))
        # If none detected, pick first three columns
        if not display_cols:
            take = col_names[:3]
            for c in take:
                display_cols.append((c, c))

        cols = [k for k, _v in display_cols]
        tree = ttk.Treeview(popup, columns=cols, show='headings')
        for col, (col_key, src_col) in zip(cols, display_cols):
            heading = col_key.capitalize() if col_key in ('description','category','rvu') else str(src_col)
            tree.heading(col, text=heading)
            tree.column(col, width=300 if col_key=='description' else (180 if col_key=='category' else 120))
        tree.pack(fill='both', expand=True, padx=6, pady=6)

        def populate_rvus(search_text=''):
            for item in tree.get_children():
                tree.delete(item)
            txt_lower = search_text.lower()
            
            # Use sorted order when no search, original order when searching
            indices_to_use = sorted_indices if not txt_lower else range(len(rvudf))
            
            for idx in indices_to_use:
                row = rvudf.iloc[idx]
                # Build display values from detected columns
                vals = []
                for _, src_col in display_cols:
                    val = row.get(src_col, '')
                    vals.append(str(val) if val is not None else '')
                # Filter by search text in description column if available
                if txt_lower and desc_col:
                    desc_val = str(row.get(desc_col, '')).lower()
                    if txt_lower not in desc_val:
                        continue
                tree.insert('', 'end', values=tuple(vals))

        populate_rvus()

        def on_search(*_):
            populate_rvus(search_var.get())

        search_var.trace_add('write', lambda *_: on_search())

        # Selection button
        btn_frame = ttk.Frame(popup)
        btn_frame.pack(fill='x', padx=6, pady=6)

        def on_select():
            selection = tree.selection()
            if not selection:
                messagebox.showwarning("No Selection", "Please select an RVU entry.")
                return
            vals = tree.item(selection[0], 'values')
            # Find the RVU value from the selected row
            if rvu_col:
                rvu_idx = [i for i, (k, _) in enumerate(display_cols) if k == 'rvu']
                if rvu_idx and len(vals) > rvu_idx[0]:
                    try:
                        sel['value'] = float(vals[rvu_idx[0]])
                    except Exception:
                        sel['value'] = None
            popup.destroy()

        ttk.Button(btn_frame, text='Import Selected', command=on_select).pack(side='left', padx=6)
        ttk.Button(btn_frame, text='Cancel', command=popup.destroy).pack(side='left')

        # Allow manual RVU entry
        manual_row = ttk.Frame(popup)
        manual_row.pack(fill='x', pady=6, padx=6)
        ttk.Label(manual_row, text='Manual RVU:').pack(side='left')
        manual_var = tk.StringVar()
        manual_entry = ttk.Entry(manual_row, textvariable=manual_var, width=12)
        manual_entry.pack(side='left', padx=6)

        def use_manual():
            try:
                sel['value'] = float(manual_var.get())
            except Exception:
                sel['value'] = None
            popup.destroy()

        ttk.Button(manual_row, text='Use Manual', command=use_manual).pack(side='left', padx=6)

        # modal
        popup.transient(self.root)
        popup.grab_set()
        self.root.wait_window(popup)
        
        return sel['value']

    def _convert_pattern_to_steps(self, key: str, content: str):
        """Convert raw pattern text into structured steps format.
        Steps are numbered 1, 2, 3... where each number starts a new step.
        Text following each number is treated as 'how_to_view_this_region'.
        """
        lines = content.split('\n')
        steps = []
        current_step_title = None
        current_content = []

        for line in lines:
            line_stripped = line.rstrip()
            line_for_match = line_stripped.strip()
            # Check if line starts with a number (1. 2. 3. etc)
            if re.match(r'^\d+[\.\s]', line_for_match):
                # Save previous step if exists
                if current_step_title is not None:
                    step = {
                        'step_title': current_step_title,
                        'how_to_view_this_region': '\n'.join(current_content).strip(),
                        'DONT_FORGET': 'TBD',
                        'DO_NOT_MISS_Pathology': 'TBD',
                        'Normal_report': 'TBD'
                    }
                    steps.append(step)
                # Start new step
                match = re.match(r'^(\d+)[\.\s](.*)', line_for_match)
                current_step_title = match.group(2) if match else f"Step {match.group(1)}"
                current_content = []
            elif current_step_title is not None:
                if not line_for_match:
                    # Preserve paragraph spacing inside step content
                    if not current_content or current_content[-1] != "":
                        current_content.append("")
                else:
                    current_content.append(line_for_match)

        # Save last step
        if current_step_title is not None:
            step = {
                'step_title': current_step_title,
                'how_to_view_this_region': '\n'.join(current_content).strip(),
                'DONT_FORGET': 'TBD',
                'DO_NOT_MISS_Pathology': 'TBD',
                'Normal_report': 'TBD'
            }
            steps.append(step)

        # If no numbered steps found, treat entire content as a single step
        if not steps:
            steps = [{
                'step_title': 'Main Step',
                'how_to_view_this_region': content.strip(),

            }]

        # Save imported/converted pattern to HDF5
        study_label = key
        modality = self.new_modality_var.get() if hasattr(self, 'new_modality_var') else "Not specified"
        contrast = self.contrast_var.get() if hasattr(self, 'contrast_var') else "Not specified"
        indication = "From built-in patterns"

        full_study_name = f"{study_label} ({modality} | {contrast} | Style: Imported | Indication: {indication})"

        try:
            self._append_new_pattern_to_file(full_study_name, steps)
            self._reload_search_patterns()
            messagebox.showinfo("Success", f"Pattern imported and saved for:\n{full_study_name}")
            self.notebook.select(self.view_tab)
            self.load_builtin_patterns()
            self.study_combo.set(full_study_name)
            self.load_pattern(full_study_name)
        except Exception as e:
            messagebox.showerror("Save Error", f"Failed to save imported pattern:\n{str(e)}")

    def generate_pattern(self, user_ref_ctx=None):
        new_study = self.new_study_entry.get().strip()
        if not new_study:
            self.root.after(0, lambda: messagebox.showerror("Error", "Please enter a study type."))
            self.root.after(0, self.finish_generation)
            return

        modality = self.new_modality_var.get()
        contrast = self.contrast_var.get()
        indication = self.indication_entry.get().strip() if self.include_indication_var.get() else None

        # Prepare display texts with sensible defaults
        modality_text = modality if modality else "Not specified"
        contrast_text = contrast if contrast else "Not specified"
        indication_text = indication if indication else "None"

        # Pattern style (human-readable) and style suffix used in prompts
        selected_style = self.prompt_style_combo.get()
        style_text = selected_style if selected_style else "Default"
        style_suffix = self.prompt_styles.get(selected_style, "systematic search pattern")

        # Save a combined Study_Type that includes modality, contrast, style, and indication
        full_study_name = f"{new_study} ({modality_text} | {contrast_text} | Style: {style_text} | Indication: {indication_text})"

        # --- Two-agent protocol: find most similar existing pattern and use as context ---
        try:
            # Indicate that matching is starting
            try:
                self.root.after(0, lambda: self.agent_status_label.config(text="AI agent: matching...", foreground="orange"))
            except Exception:
                pass

            # Determine strictness settings
            strict_choice = self.matching_strictness_var.get() if getattr(self, 'matching_strictness_var', None) else 'Default'
            threshold, boost = self.strictness_map.get(strict_choice, (0.55, 0.18))

            matcher = SemanticMatcher(SEARCH_PATTERNS, openai_client=None, openai_api_key=self.openai_key_var.get().strip())
            similar_key, sim_score = matcher.find_best(new_study, preferred_term=modality, boost=boost)
            # Save last match info to instance for later UI
            self.last_match_backend = getattr(matcher, 'last_backend', None)
            self.last_match_score = sim_score
            self.last_match_key = similar_key

            # if similarity is lower than the selected strictness threshold, try conservative fallback
            if similar_key is None or (sim_score is not None and sim_score < threshold):
                matches = difflib.get_close_matches(new_study, list(SEARCH_PATTERNS.keys()), n=1, cutoff=0.45)
                if matches:
                    similar_key = matches[0]
        except Exception:
            similar_key = None

        similar_context = SEARCH_PATTERNS.get(similar_key, "") if similar_key else ""
        # Update the agent status label with matching results (backend and score if available)
        try:
            if getattr(self, 'last_match_backend', None):
                score = self.last_match_score if self.last_match_score is not None else 0.0
                self.root.after(0, lambda: self.agent_status_label.config(text=f"AI agent: {self.last_match_backend} match={score:.2f}", foreground="#0077aa"))
            elif similar_key:
                self.root.after(0, lambda: self.agent_status_label.config(text=f"AI agent: matched '{similar_key}'", foreground="#0077aa"))
            else:
                self.root.after(0, lambda: self.agent_status_label.config(text="AI agent: no good match", foreground="#666666"))
        except Exception:
            pass
        # Update the UI matched label and prefill reference_text only if the user hasn't provided custom text
        def _update_ref_ui():
            if similar_key:
                self.matched_label.config(text=similar_key)
            else:
                self.matched_label.config(text="(none)")
            try:
                # Only prefill the reference text if the user didn't already provide a custom context
                if not user_ref_ctx:
                    self.reference_text.delete(1.0, tk.END)
                    if similar_context:
                        self.reference_text.insert(tk.END, similar_context)
            except Exception:
                pass

        self.root.after(0, _update_ref_ui)
        if similar_key:
            # trim context to a reasonable size to avoid overly long prompts
            similar_context = similar_context.strip()
            # Allow a much larger context to be used; trim only if extremely long
            if len(similar_context) > 20000:
                similar_context = similar_context[:20000] + '\n... (trimmed)'

        # Prefer the user's edited reference context (snapshot) if provided, otherwise use the matched context
        ref_ctx = user_ref_ctx if user_ref_ctx else (similar_context if similar_context else "")

        # If indication is not enabled, remove the Indication line from the base template
        base_template = self.base_goal_template
        if not self.include_indication_var.get():
            base_template = re.sub(r'(?m)^- Indication:.*\n?', '', base_template)

        # Include reference_context when formatting the base template to avoid KeyError
        base_goal = base_template.format(
            study_type=new_study,
            modality=modality or "Not specified",
            contrast=contrast or "Not specified",
            indication=indication or "Not specified",
            style_suffix=style_suffix,
            reference_context=ref_ctx
        )
        # Build a human-friendly block listing available prompt styles and examples
        try:
            styles_block = "\n".join([f"- {k}: {v}" for k, v in self.prompt_styles.items()]) if getattr(self, 'prompt_styles', None) else ""
        except Exception:
            styles_block = ""

        # Instruct model to omit certain subsections (blind_spots, planes, windows)
        reduced_keys_instruction = ("\nADDITIONAL OUTPUT INSTRUCTIONS:\n"
                        "- Output ONLY a JSON array of objects. Each object must contain EXACTLY the following keys:\n"
                        "  'step_title', 'how_to_view_this_region', 'DONT_FORGET', 'DO_NOT_MISS_Pathology', 'Normal_report'\n"
                        "- Do NOT include other fields or commentary outside the JSON.\n")

        full_prompt = (self.full_prompt_template.format(base_goal=base_goal, reference_context=ref_ctx, prompt_styles_examples=styles_block)
                   + "\n" + reduced_keys_instruction)

        provider = self.llm_provider.get()

        generated = None
        try:
            if provider == "openai":
                api_key = self.openai_key_var.get().strip()
                if not api_key:
                    raise Exception("No API key")
                client = OpenAIClient(api_key=api_key)
                # Request a longer, focused response. Adjust tokens/temperature for verbosity and consistency.
                response = client.chat.completions.create(
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": full_prompt}],
                    max_tokens=4000,
                    temperature=0.2
                )
                generated = response.choices[0].message.content.strip()

            else:
                model = self.ollama_model_var.get().strip() or "llama3.2:latest"
                if not OLLAMA_AVAILABLE:
                    raise Exception("ollama package not installed")
                ollama.list()
                # Request a longer, focused response from Ollama if available.
                try:
                    response = ollama.chat(model=model, messages=[{"role": "user", "content": full_prompt}], max_tokens=4000, temperature=0.2)
                except TypeError:
                    # Some ollama client versions may not accept those kwargs
                    response = ollama.chat(model=model, messages=[{"role": "user", "content": full_prompt}])
                generated = response['message']['content'].strip()
        except Exception as e:
            self.root.after(0, lambda: messagebox.showerror("Generation Error", f"Failed:\n{str(e)}"))
            self.root.after(0, self.finish_generation)
            return

        try:
            steps_list = json.loads(generated)
        except:
            match = re.search(r'\[.*\]', generated, re.DOTALL)
            steps_list = json.loads(match.group(0)) if match else []

        if not steps_list:
            steps_list = []

        # If the output is shorter than desired, try one automatic expansion pass
        desired_min_steps = 8
        if len(steps_list) < desired_min_steps:
            try:
                expand_instruction = ("The previous output was shorter than required. Expand and elaborate so the final output contains at least "
                                      f"{desired_min_steps} steps. For each step, increase detail in the how_to_view_this_region field. "
                                      "Preserve JSON-only output: return a JSON array of objects with exactly the required keys.")

                expand_prompt = full_prompt + "\n\nADDITIONAL INSTRUCTIONS:\n" + expand_instruction + "\nPREVIOUS_OUTPUT:\n" + generated

                # call LLM again to expand
                if provider == "openai":
                    response = client.chat.completions.create(
                        model="gpt-4o-mini",
                        messages=[{"role": "user", "content": expand_prompt}],
                        max_tokens=5000,
                        temperature=0.2
                    )
                    expanded = response.choices[0].message.content.strip()
                else:
                    try:
                        response = ollama.chat(model=model, messages=[{"role": "user", "content": expand_prompt}], max_tokens=5000, temperature=0.2)
                    except TypeError:
                                               response = ollama.chat(model=model, messages=[{"role": "user", "content": expand_prompt}])
                    expanded = response['message']['content'].strip()

                # Try parsing expanded output
                try:
                    new_list = json.loads(expanded)
                except:
                    m = re.search(r'\[.*\]', expanded, re.DOTALL)
                    new_list = json.loads(m.group(0)) if m else []

                if new_list and len(new_list) >= len(steps_list):
                    steps_list = new_list
                    generated = json.dumps(steps_list)
            except Exception:
                # If expansion fails, continue with original result
                pass

        # Filter steps to include only the approved keys for storage: step_title, DONT_FORGET (questions_to_ask), DO_NOT_MISS_Pathology, Normal_report
        filtered_steps = []
        for s in steps_list:
            try:
                title = s.get('step_title', '')
            except Exception:
                title = ''

            how_to_view = s.get('how_to_view_this_region') if isinstance(s, dict) else None    

            # Normalize 'Don't Forget' content from multiple possible keys
            dont_forget = None
            if isinstance(s, dict):
                dont_forget = s.get('DONT_FORGET')
            if dont_forget is None:
                dont_forget = ""

            normal_report = s.get('Normal_report') if isinstance(s, dict) else None
            if not normal_report:
                normal_report = s.get('Normal_report_findings') or s.get('normal_report') or ""

            do_not_miss = s.get('DO_NOT_MISS_Pathology') if isinstance(s, dict) else None
            if do_not_miss is None:
                do_not_miss = ""

            filtered = {
                'step_title': title,
                'how_to_view_this_region': how_to_view,
                'DONT_FORGET': dont_forget,
                'DO_NOT_MISS_Pathology': do_not_miss,
                'Normal_report': normal_report
            }
            filtered_steps.append(filtered)

        generated_json = json.dumps(filtered_steps, ensure_ascii=False)

        try:
            self._append_new_pattern_to_file(full_study_name, filtered_steps)
            self._reload_search_patterns()
            self.root.after(0, lambda: self.finish_generation_success(full_study_name))
        except Exception as e:
            # If saving fails, show an error so user is aware
            print(f"Failed to save pattern: {e}")
            self.root.after(0, lambda: messagebox.showerror("Save Error", f"Failed to save pattern to HDF5 storage: {e}"))
            self.root.after(0, self.finish_generation)

    def finish_generation(self):
        self.gen_progress.stop()
        self.gen_progress.pack_forget()
        self.generate_btn.config(state='normal')

    def finish_generation_success(self, study_name):
        self.finish_generation()
        messagebox.showinfo("Success", f"Pattern generated and saved for:\n{study_name}")
        self.notebook.select(self.view_tab)
        self.load_builtin_patterns()
        self.study_combo.set(study_name)
        self.load_pattern(study_name)
        # Update agent status to idle and show last match summary if available
        try:
            if getattr(self, 'last_match_backend', None):
                backend = self.last_match_backend
                score = self.last_match_score if getattr(self, 'last_match_score', None) is not None else 0.0
                key = self.last_match_key if getattr(self, 'last_match_key', None) else ''
                self.agent_status_label.config(text=f"AI agent: idle (last: {backend} {score:.2f} match '{key}')", foreground="#0077aa")
            else:
                self.agent_status_label.config(text="AI agent: idle", foreground="#0077aa")
        except Exception:
            pass

if __name__ == "__main__":
    root = tk.Tk()
    app = RadiologyAssistant(root)
    root.mainloop()
