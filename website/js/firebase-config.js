// firebase-config.js — plain script, no modules
// Edit firebaseConfig below with your actual project values.

const firebaseConfig = {
  apiKey: "AIzaSyDlquPt5kXXNNmdk9Xg8xfGPYse5yKYAQk",
  authDomain: "searches-app.firebaseapp.com",
  projectId: "searches-app",
  storageBucket: "searches-app.firebasestorage.app",
  messagingSenderId: "1045373410297",
  appId: "1:1045373410297:web:409826091982cc801c7b28",
  measurementId: "G-Z421WPNZ8K"
};

firebase.initializeApp(firebaseConfig);

var appAuth = firebase.auth();
var appDb   = firebase.firestore();

// Enable offline persistence
appDb.enablePersistence({ synchronizeTabs: true }).catch(function(err) {
  if (err.code === 'failed-precondition') {
    console.warn('Firestore persistence unavailable: multiple tabs open.');
  } else if (err.code === 'unimplemented') {
    console.warn('Firestore persistence not supported in this browser.');
  }
});

