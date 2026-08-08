/**
 * Shared vacation cloud sync (Firebase Auth + Firestore).
 * Both accounts join the same trip via invite code and receive live updates.
 */
(function (global) {
  const LS_CONFIG = "vacation_firebase_config";
  const LS_TRIP = "vacation_trip_id";
  const LS_INVITE = "vacation_invite_code";

  let app = null;
  let auth = null;
  let db = null;
  let storage = null;
  let unsubEvents = null;
  let unsubAtts = null;
  let authWired = false;
  const MAX_FILE_BYTES = 25 * 1024 * 1024;

  const listeners = new Set();
  const state = {
    ready: false,
    user: null,
    tripId: null,
    inviteCode: null,
    events: [],
    attachments: {},
    error: null,
    status: "offline"
  };

  function notify() {
    listeners.forEach((fn) => {
      try { fn(getState()); } catch (_) {}
    });
  }

  function getState() {
    return {
      ready: state.ready,
      user: state.user ? { uid: state.user.uid, email: state.user.email } : null,
      tripId: state.tripId,
      inviteCode: state.inviteCode,
      events: state.events.slice(),
      attachments: { ...state.attachments },
      error: state.error,
      status: state.status,
      configured: !!getConfig()
    };
  }

  function onChange(fn) {
    listeners.add(fn);
    fn(getState());
    return () => listeners.delete(fn);
  }

  function getConfig() {
    try {
      const raw = localStorage.getItem(LS_CONFIG);
      if (raw) return JSON.parse(raw);
    } catch (_) {}
    if (global.FIREBASE_CONFIG && global.FIREBASE_CONFIG.apiKey && !String(global.FIREBASE_CONFIG.apiKey).includes("YOUR_")) {
      return global.FIREBASE_CONFIG;
    }
    return null;
  }

  function saveConfig(cfg) {
    localStorage.setItem(LS_CONFIG, JSON.stringify(cfg));
  }

  function ensureFirebase() {
    const cfg = getConfig();
    if (!cfg) throw new Error("Firebase is not configured yet.");
    if (!global.firebase) throw new Error("Firebase SDK not loaded.");
    if (!app) {
      app = firebase.apps && firebase.apps.length ? firebase.app() : firebase.initializeApp(cfg);
      auth = firebase.auth();
      db = firebase.firestore();
      storage = firebase.storage();
      try {
        db.enablePersistence({ synchronizeTabs: true }).catch(() => {});
      } catch (_) {}
    }
    return { auth, db, storage };
  }

  function randomCode(len) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    for (let i = 0; i < len; i++) out += chars[arr[i] % chars.length];
    return out;
  }

  function stopListeners() {
    if (unsubEvents) { unsubEvents(); unsubEvents = null; }
    if (unsubAtts) { unsubAtts(); unsubAtts = null; }
  }

  function normalizeAttachment(id, data) {
    return {
      id,
      eventId: data.eventId,
      kind: data.kind || (data.url && !data.dataUrl ? "link" : "file"),
      fileName: data.fileName || data.name || "File",
      fileType: data.fileType || data.type || "application/octet-stream",
      name: data.fileName || data.name || "File",
      type: data.fileType || data.type || "application/octet-stream",
      size: data.size || 0,
      url: data.url || "",
      label: data.label || "",
      dataUrl: data.dataUrl || "",
      storagePath: data.storagePath || "",
      createdAt: data.createdAt || data.updatedAt || Date.now(),
      updatedAt: data.updatedAt || Date.now()
    };
  }

  function dataUrlToBlob(dataUrl) {
    const parts = String(dataUrl || "").split(",");
    if (parts.length < 2) throw new Error("Invalid file data");
    const header = parts[0];
    const data = parts.slice(1).join(",");
    const mime = (header.match(/data:([^;]+)/) || [])[1] || "application/octet-stream";
    const isBase64 = /;base64/i.test(header);
    if (isBase64) {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new Blob([bytes], { type: mime });
    }
    return new Blob([decodeURIComponent(data)], { type: mime });
  }

  function safeFileName(name) {
    return String(name || "file").replace(/[^\w.\-()+ ]+/g, "_").slice(0, 120);
  }

  function canSeedAttachment(att) {
    if (!att) return false;
    if (att.kind === "link") return true;
    // File seeds are uploaded via Storage during create; allow if we have bytes.
    return !!(att.file || att.dataUrl || att.url);
  }

  function startTripListeners(tripId) {
    stopListeners();
    state.status = "syncing";
    notify();

    unsubEvents = db.collection("trips").doc(tripId).collection("events")
      .onSnapshot((snap) => {
        const list = [];
        snap.forEach((doc) => list.push({ id: doc.id, ...doc.data() }));
        state.events = list;
        state.status = "live";
        state.error = null;
        notify();
      }, (err) => {
        state.error = err.message || String(err);
        state.status = "error";
        notify();
      });

    unsubAtts = db.collection("trips").doc(tripId).collection("attachments")
      .onSnapshot((snap) => {
        const map = {};
        snap.forEach((doc) => {
          map[doc.id] = normalizeAttachment(doc.id, doc.data() || {});
        });
        state.attachments = map;
        notify();
      }, (err) => {
        state.error = err.message || String(err);
        notify();
      });
  }

  async function loadTripMeta(tripId) {
    const tripSnap = await db.collection("trips").doc(tripId).get();
    if (!tripSnap.exists) throw new Error("Shared trip not found.");
    const data = tripSnap.data();
    state.tripId = tripId;
    state.inviteCode = data.inviteCode || localStorage.getItem(LS_INVITE) || null;
    localStorage.setItem(LS_TRIP, tripId);
    if (state.inviteCode) localStorage.setItem(LS_INVITE, state.inviteCode);
    startTripListeners(tripId);
  }

  async function createTrip(seedEvents, seedAttachments) {
    ensureFirebase();
    if (!state.user) throw new Error("Sign in first.");

    // Create trip + invite first (separate from seed data) so rules/batch limits don't hide the code.
    const tripRef = db.collection("trips").doc();
    const inviteCode = randomCode(6);
    const setup = db.batch();
    setup.set(tripRef, {
      name: "Summer Vacation 2026",
      inviteCode,
      createdBy: state.user.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      members: [state.user.uid],
      memberEmails: [state.user.email || ""]
    });
    setup.set(db.collection("inviteCodes").doc(inviteCode), {
      tripId: tripRef.id,
      createdBy: state.user.uid,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    setup.set(db.collection("users").doc(state.user.uid), {
      email: state.user.email || "",
      tripId: tripRef.id,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    await setup.commit();

    state.inviteCode = inviteCode;
    localStorage.setItem(LS_INVITE, inviteCode);
    localStorage.setItem(LS_TRIP, tripRef.id);

    // Seed after trip exists. Never fail trip creation because of seed/attachment size.
    try {
      const events = Array.isArray(seedEvents) ? seedEvents : [];
      for (let i = 0; i < events.length; i += 400) {
        const chunk = events.slice(i, i + 400);
        const batch = db.batch();
        chunk.forEach((ev) => {
          const id = String(ev.id || ("ev_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7)));
          const { id: _drop, ...rest } = ev;
          // Strip any accidental huge fields from legacy local event objects
          const clean = { ...rest };
          if (clean.dataUrl) delete clean.dataUrl;
          batch.set(tripRef.collection("events").doc(id), { ...clean, updatedAt: Date.now() });
        });
        await batch.commit();
      }

      // Temporarily point state at new trip so Storage uploads work during seed.
      const previousTripId = state.tripId;
      state.tripId = tripRef.id;
      const atts = seedAttachments || {};
      const attList = (Array.isArray(atts) ? atts : Object.values(atts)).filter(canSeedAttachment);
      for (const a of attList) {
        try {
          await upsertAttachment({
            ...a,
            id: a.id || ("att_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7))
          });
        } catch (_) {
          // Skip individual bad attachments
        }
      }
      state.tripId = previousTripId;
    } catch (seedErr) {
      console.warn("Trip created, but seeding some local data failed:", seedErr);
    }

    await loadTripMeta(tripRef.id);
    return { tripId: tripRef.id, inviteCode };
  }

  async function joinTrip(inviteCode) {
    ensureFirebase();
    if (!state.user) throw new Error("Sign in first.");
    const code = String(inviteCode || "").trim().toUpperCase();
    if (!code) throw new Error("Enter an invite code.");
    let codeSnap;
    try {
      codeSnap = await db.collection("inviteCodes").doc(code).get();
    } catch (err) {
      if (err && err.code === "permission-denied") {
        throw new Error("Permission denied reading invite code. Publish the latest Firestore rules, then try again.");
      }
      throw err;
    }
    if (!codeSnap.exists) throw new Error("Invite code not found. Check the code from your partner’s Account & invite menu.");
    const tripId = codeSnap.data().tripId;
    const tripRef = db.collection("trips").doc(tripId);
    try {
      await tripRef.update({
        members: firebase.firestore.FieldValue.arrayUnion(state.user.uid),
        memberEmails: firebase.firestore.FieldValue.arrayUnion(state.user.email || "")
      });
    } catch (err) {
      if (err && err.code === "permission-denied") {
        throw new Error("Permission denied joining trip. In Firebase → Firestore → Rules, publish the latest firestore.rules, then try Join again.");
      }
      throw err;
    }
    await db.collection("users").doc(state.user.uid).set({
      email: state.user.email || "",
      tripId,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    state.inviteCode = code;
    await loadTripMeta(tripId);
    return { tripId, inviteCode: code };
  }

  async function signUp(email, password) {
    ensureFirebase();
    const cred = await auth.createUserWithEmailAndPassword(email.trim(), password);
    state.user = cred.user;
    notify();
    return cred.user;
  }

  async function signIn(email, password) {
    ensureFirebase();
    const cred = await auth.signInWithEmailAndPassword(email.trim(), password);
    state.user = cred.user;
    notify();
    return cred.user;
  }

  async function signOut() {
    stopListeners();
    if (auth) await auth.signOut();
    state.user = null;
    state.tripId = null;
    state.inviteCode = null;
    state.events = [];
    state.attachments = {};
    state.status = "offline";
    localStorage.removeItem(LS_TRIP);
    notify();
  }

  async function upsertEvent(event) {
    if (!state.tripId) throw new Error("Join a shared trip first.");
    const id = String(event.id || ("ev_" + Date.now()));
    const { id: _i, ...rest } = event;
    await db.collection("trips").doc(state.tripId).collection("events").doc(id).set({
      ...rest,
      updatedAt: Date.now()
    }, { merge: true });
    return id;
  }

  async function deleteEventDoc(eventId) {
    if (!state.tripId) throw new Error("Join a shared trip first.");
    await db.collection("trips").doc(state.tripId).collection("events").doc(String(eventId)).delete();
  }

  async function upsertAttachment(att) {
    ensureFirebase();
    if (!state.tripId) throw new Error("Join a shared trip first.");
    const id = String(att.id || ("att_" + Date.now()));
    const kind = att.kind || (att.url && !att.file && !att.dataUrl ? "link" : "file");
    const fileName = att.fileName || att.name || (kind === "link" ? "Link" : "file");
    const fileType = att.fileType || att.type || "application/octet-stream";
    const createdAt = att.createdAt || Date.now();

    if (kind === "link") {
      await db.collection("trips").doc(state.tripId).collection("attachments").doc(id).set({
        eventId: att.eventId,
        kind: "link",
        fileName,
        fileType: "text/uri-list",
        name: fileName,
        type: "text/uri-list",
        size: 0,
        url: att.url || "",
        label: att.label || "",
        dataUrl: "",
        storagePath: "",
        createdAt,
        updatedAt: Date.now()
      }, { merge: true });
      return id;
    }

    let downloadUrl = att.url || "";
    let storagePath = att.storagePath || "";
    let size = att.size || 0;
    const blob = att.file || (att.dataUrl ? dataUrlToBlob(att.dataUrl) : null);

    if (blob) {
      size = blob.size || size;
      if (size > MAX_FILE_BYTES) {
        throw new Error("File is larger than 25MB. Use a smaller file or add a link instead.");
      }
      storagePath = `trips/${state.tripId}/attachments/${id}/${safeFileName(fileName)}`;
      const ref = storage.ref(storagePath);
      await ref.put(blob, { contentType: fileType || blob.type || "application/octet-stream" });
      downloadUrl = await ref.getDownloadURL();
    }

    if (!downloadUrl && !att.dataUrl) {
      throw new Error("No file data to upload.");
    }

    // Store only the Storage URL in Firestore (not the file bytes).
    await db.collection("trips").doc(state.tripId).collection("attachments").doc(id).set({
      eventId: att.eventId,
      kind: "file",
      fileName,
      fileType,
      name: fileName,
      type: fileType,
      size,
      url: downloadUrl,
      label: att.label || "",
      dataUrl: "",
      storagePath,
      createdAt,
      updatedAt: Date.now()
    }, { merge: true });
    return id;
  }

  async function deleteStoragePath(storagePath) {
    if (!storagePath || !storage) return;
    try {
      await storage.ref(storagePath).delete();
    } catch (_) {}
  }

  async function deleteAttachmentDoc(attachmentId) {
    if (!state.tripId) throw new Error("Join a shared trip first.");
    const ref = db.collection("trips").doc(state.tripId).collection("attachments").doc(String(attachmentId));
    const snap = await ref.get();
    if (snap.exists) {
      await deleteStoragePath(snap.data().storagePath || "");
    }
    await ref.delete();
  }

  async function deleteAttachmentsForEvent(eventId) {
    if (!state.tripId) return;
    const snap = await db.collection("trips").doc(state.tripId).collection("attachments")
      .where("eventId", "==", String(eventId)).get();
    const batch = db.batch();
    const paths = [];
    snap.forEach((doc) => {
      paths.push(doc.data().storagePath || "");
      batch.delete(doc.ref);
    });
    if (!snap.empty) await batch.commit();
    for (const path of paths) await deleteStoragePath(path);
  }

  function configure(cfg) {
    if (!cfg || !cfg.apiKey || !cfg.projectId || !cfg.appId) {
      throw new Error("Invalid Firebase config. Need apiKey, projectId, and appId.");
    }
    saveConfig(cfg);
    stopListeners();
    app = null;
    auth = null;
    db = null;
    storage = null;
    authWired = false;
    ensureFirebase();
    wireAuth();
    notify();
  }

  function wireAuth() {
    ensureFirebase();
    if (authWired) return;
    authWired = true;
    auth.onAuthStateChanged(async (user) => {
      state.user = user;
      state.ready = true;
      if (!user) {
        stopListeners();
        state.tripId = null;
        state.inviteCode = null;
        state.events = [];
        state.attachments = {};
        state.status = "offline";
        notify();
        return;
      }
      try {
        const userDoc = await db.collection("users").doc(user.uid).get();
        const tripId = (userDoc.exists && userDoc.data().tripId) || localStorage.getItem(LS_TRIP);
        if (tripId) {
          await loadTripMeta(tripId);
        } else {
          state.tripId = null;
          state.status = "no-trip";
          notify();
        }
      } catch (err) {
        state.error = err.message || String(err);
        state.status = "error";
        notify();
      }
    });
  }

  function init() {
    const cfg = getConfig();
    if (!cfg) {
      state.ready = true;
      state.status = "needs-config";
      notify();
      return;
    }
    try {
      ensureFirebase();
      wireAuth();
    } catch (err) {
      state.ready = true;
      state.error = err.message || String(err);
      state.status = "error";
      notify();
    }
  }

  global.VacationCloud = {
    init,
    configure,
    getConfig,
    getState,
    onChange,
    signUp,
    signIn,
    signOut,
    createTrip,
    joinTrip,
    upsertEvent,
    deleteEvent: deleteEventDoc,
    upsertAttachment,
    deleteAttachment: deleteAttachmentDoc,
    deleteAttachmentsForEvent
  };
})(window);
