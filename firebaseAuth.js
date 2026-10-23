
import admin from "firebase-admin";

const projectId = process.env.FIREBASE_PROJECT_ID;
const allowedUid = process.env.ALLOWED_FIREBASE_UID;

if (!projectId || !allowedUid) {
  throw new Error(
    "Missing FIREBASE_PROJECT_ID or ALLOWED_FIREBASE_UID"
  );
}

if (!admin.apps.length) {
  admin.initializeApp({
    projectId
  });
}

export async function requireFirebaseAuth(req, res, next) {
  const authorization = req.headers.authorization || "";

  const match = authorization.match(/^Bearer (.+)$/i);

  if (!match) {
    return res.status(401).json({
      error: "Authentication required"
    });
  }

  try {
    const decoded = await admin
      .auth()
      .verifyIdToken(match[1], true);

    if (decoded.uid !== allowedUid) {
      return res.status(403).json({
        error: "Account not authorized"
      });
    }

    req.user = {
      uid: decoded.uid,
      email: decoded.email || null
    };

    next();
  } catch (error) {
    console.error("Firebase authentication failed:", error.code || "invalid_token");

    return res.status(401).json({
      error: "Invalid or expired authentication"
    });
  }
}
