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
      try {
        if (firebase.storage) storage = firebase.storage();
      } catch (_) {
        storage = null;
      }
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
      kind: data.kind || (data.url && !data.dataUrl && !data.chunked ? "link" : "file"),
      fileName: data.fileName || data.name || "File",
      fileType: data.fileType || data.type || "application/octet-stream",
      name: data.fileName || data.name || "File",
      type: data.fileType || data.type || "application/octet-stream",
      size: data.size || 0,
      url: data.url || "",
      label: data.label || "",
      dataUrl: data.dataUrl || "",
      storagePath: data.storagePath || "",
      chunked: !!data.chunked,
      chunkCount: data.chunkCount || 0,
      createdAt: data.createdAt || data.updatedAt || Date.now(),
      updatedAt: data.updatedAt || Date.now()
    };
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

  // Free native uploads: small files in one doc; larger files split across chunk docs.
  // No paid Firebase Storage required.
  const CHUNK_SIZE = 700000;
  const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

  function chunksCol(tripId) {
    return db.collection("trips").doc(tripId).collection("attachmentChunks");
  }

  async function writeAttachmentChunks(tripId, attachmentId, dataUrl) {
    const chunkCount = Math.ceil(dataUrl.length / CHUNK_SIZE) || 1;
    for (let start = 0; start < chunkCount; start += 400) {
      const batch = db.batch();
      const end = Math.min(chunkCount, start + 400);
      for (let i = start; i < end; i++) {
        batch.set(chunksCol(tripId).doc(attachmentId + "_" + i), {
          attachmentId,
          index: i,
          data: dataUrl.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE)
        });
      }
      await batch.commit();
    }
    return chunkCount;
  }

  async function deleteAttachmentChunks(tripId, attachmentId, chunkCount) {
    const count = Number(chunkCount) || 0;
    if (!count) return;
    for (let start = 0; start < count; start += 400) {
      const batch = db.batch();
      const end = Math.min(count, start + 400);
      for (let i = start; i < end; i++) {
        batch.delete(chunksCol(tripId).doc(attachmentId + "_" + i));
      }
      await batch.commit();
    }
  }

  async function getAttachmentDataUrl(attachmentId) {
    ensureFirebase();
    if (!state.tripId) throw new Error("Join a shared trip first.");
    const id = String(attachmentId);
    let meta = state.attachments[id];
    if (!meta) {
      const snap = await db.collection("trips").doc(state.tripId).collection("attachments").doc(id).get();
      if (!snap.exists) throw new Error("Attachment not found.");
      meta = normalizeAttachment(id, snap.data() || {});
    }
    if (meta.kind === "link") return meta.url || "";
    if (meta.dataUrl) return meta.dataUrl;
    if (meta.url && !meta.chunked) return meta.url;
    if (meta.chunked && meta.chunkCount) {
      let out = "";
      for (let i = 0; i < meta.chunkCount; i++) {
        const snap = await chunksCol(state.tripId).doc(id + "_" + i).get();
        if (!snap.exists) throw new Error("File data is incomplete. Try uploading again.");
        out += snap.data().data || "";
      }
      return out;
    }
    throw new Error("This attachment has no file data.");
  }

  async function upsertAttachment(att) {
    ensureFirebase();
    if (!state.tripId) throw new Error("Join a shared trip first.");
    const id = String(att.id || ("att_" + Date.now()));
    const kind = att.kind || (att.url && !att.file && !att.dataUrl ? "link" : "file");
    const fileName = att.fileName || att.name || (kind === "link" ? "Link" : "file");
    const fileType = att.fileType || att.type || "application/octet-stream";
    const createdAt = att.createdAt || Date.now();
    const attRef = db.collection("trips").doc(state.tripId).collection("attachments").doc(id);

    if (kind === "link") {
      await attRef.set({
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
        chunked: false,
        chunkCount: 0,
        storagePath: "",
        createdAt,
        updatedAt: Date.now()
      }, { merge: true });
      return id;
    }

    let dataUrl = att.dataUrl || "";
    let size = att.size || 0;

    if (!dataUrl && att.file) {
      if ((att.file.size || 0) > MAX_UPLOAD_BYTES) {
        throw new Error("File is larger than 8MB. Please use a smaller file.");
      }
      dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("Could not read file."));
        reader.readAsDataURL(att.file);
      });
      size = att.file.size || size;
    }

    if (!dataUrl && att.url) {
      await attRef.set({
        eventId: att.eventId,
        kind: "file",
        fileName,
        fileType,
        name: fileName,
        type: fileType,
        size,
        url: att.url,
        label: att.label || "",
        dataUrl: "",
        chunked: false,
        chunkCount: 0,
        storagePath: att.storagePath || "",
        createdAt,
        updatedAt: Date.now()
      }, { merge: true });
      return id;
    }

    if (!dataUrl) throw new Error("No file data to save.");
    if (dataUrl.length > MAX_UPLOAD_BYTES * 1.4) {
      throw new Error("File is too large after encoding (max about 8MB).");
    }

    // Remove previous chunks if replacing
    try {
      const prev = await attRef.get();
      if (prev.exists && prev.data().chunked && prev.data().chunkCount) {
        await deleteAttachmentChunks(state.tripId, id, prev.data().chunkCount);
      }
    } catch (_) {}

    if (dataUrl.length <= CHUNK_SIZE) {
      await attRef.set({
        eventId: att.eventId,
        kind: "file",
        fileName,
        fileType,
        name: fileName,
        type: fileType,
        size: size || dataUrl.length,
        url: "",
        label: att.label || "",
        dataUrl,
        chunked: false,
        chunkCount: 0,
        storagePath: "",
        createdAt,
        updatedAt: Date.now()
      }, { merge: true });
      return id;
    }

    const chunkCount = await writeAttachmentChunks(state.tripId, id, dataUrl);
    await attRef.set({
      eventId: att.eventId,
      kind: "file",
      fileName,
      fileType,
      name: fileName,
      type: fileType,
      size: size || dataUrl.length,
      url: "",
      label: att.label || "",
      dataUrl: "",
      chunked: true,
      chunkCount,
      storagePath: "",
      createdAt,
      updatedAt: Date.now()
    }, { merge: true });
    return id;
  }

  async function deleteAttachmentDoc(attachmentId) {
    if (!state.tripId) throw new Error("Join a shared trip first.");
    const id = String(attachmentId);
    const ref = db.collection("trips").doc(state.tripId).collection("attachments").doc(id);
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data() || {};
      if (data.chunked && data.chunkCount) {
        await deleteAttachmentChunks(state.tripId, id, data.chunkCount);
      }
    }
    await ref.delete();
  }

  async function deleteAttachmentsForEvent(eventId) {
    if (!state.tripId) return;
    const snap = await db.collection("trips").doc(state.tripId).collection("attachments")
      .where("eventId", "==", String(eventId)).get();
    for (const doc of snap.docs) {
      const data = doc.data() || {};
      if (data.chunked && data.chunkCount) {
        await deleteAttachmentChunks(state.tripId, doc.id, data.chunkCount);
      }
    }
    const batch = db.batch();
    snap.forEach((doc) => batch.delete(doc.ref));
    if (!snap.empty) await batch.commit();
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
    deleteAttachmentsForEvent,
    getAttachmentDataUrl
  };
})(window);
