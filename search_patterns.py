import pdfplumber
import re
from collections import OrderedDict

PDF_PATH = "Search Pattern.pdf"

def extract_full_text(pdf_path):
    with pdfplumber.open(pdf_path) as pdf:
        return "\n".join(
            page.extract_text() or ""
            for page in pdf.pages
        )

def find_study_headers(text):
    MODALITY_KEYWORDS = (
        "Radiograph", "CT", "CTA", "MRI",
        "US", "Ultrasound", "PET",
        "Fluoroscopic", "Mammogram", "Tomosynthesis",
        "Scan"
    )

    EXCLUDED_PHRASES = (
        "Abbreviated Checklist",
        "General Approach",
        "Assessing",
        "Considerations",
        "How to",
        "Notes on",
        "may be",
        "is done",
        "can be",
        "for screening",
        "for evaluation",
        "Exams for",
    )

    BAD_ENDINGS = (" for", " of", " and", " to", " with")

    lines = text.splitlines()
    headers = []

    for i, line in enumerate(lines):
        line = line.strip()

        if not (6 < len(line) < 80):
            continue

        if line.isupper():
            continue

        if any(p.lower() in line.lower() for p in EXCLUDED_PHRASES):
            continue

        if any(line.lower().endswith(e) for e in BAD_ENDINGS):
            continue

        if not any(k in line for k in MODALITY_KEYWORDS):
            continue

        # Reject obvious prose sentences
        if re.search(r"\b(is|are|may|can|should|performed)\b", line.lower()):
            continue

        # Look ahead until the next plausible header
        lookahead_block = "\n".join(lines[i+1:i+60])

        # MUST contain a numbered checklist somewhere in the section
        if not re.search(r"\n\s*1\.\s", lookahead_block):
            continue

        if re.match(r"^[A-Z][A-Za-z0-9 \-/()]+$", line):
            headers.append(line)

    return list(dict.fromkeys(headers))


def extract_search_patterns(text, headers):
    patterns = OrderedDict()

    for i, header in enumerate(headers):
        start = re.search(rf"\n{re.escape(header)}\n", text)
        if not start:
            continue

        start_idx = start.end()

        if i + 1 < len(headers):
            next_header = headers[i + 1]
            end = re.search(rf"\n{re.escape(next_header)}\n", text[start_idx:])
            end_idx = start_idx + end.start() if end else len(text)
        else:
            end_idx = len(text)

        block = text[start_idx:end_idx].strip()
        patterns[header] = normalize_text(block)

    return patterns

def normalize_text(text):
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def build_search_pattern_dict(pdf_path):
    text = extract_full_text(pdf_path)
    headers = find_study_headers(text)
    patterns = extract_search_patterns(text, headers)
    return patterns

def save_dict_as_python_module(search_patterns: dict, output_path: str):
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("# Auto-generated from Search Pattern.pdf\n")
        f.write("# DO NOT EDIT MANUALLY\n\n")
        f.write("SEARCH_PATTERNS = {\n")

        for study, pattern in search_patterns.items():
            safe_pattern = pattern.replace('"""', r'\"\"\"')
            f.write(f'    "{study}": """{safe_pattern}""",\n\n')

        f.write("}\n")



if __name__ == "__main__":
    search_pattern_dict = build_search_pattern_dict(PDF_PATH)

    output_file = "radiology_search_patterns.py"
    save_dict_as_python_module(search_pattern_dict, output_file)

    print(f"Saved {len(search_pattern_dict)} study patterns to {output_file}")

