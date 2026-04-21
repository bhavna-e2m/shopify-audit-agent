import { google } from "googleapis";

function buildDocRequestsFromMarkdown(markdown) {
  const lines = (markdown || "").replace(/\r\n/g, "\n").split("\n");
  const requests = [];
  let text = "";
  let cursor = 1; // Google Docs body starts at index 1

  const parseInlineBold = (value) => {
    const boldRanges = [];
    let plain = "";
    let lastIndex = 0;
    let plainCursor = 0;
    const re = /\*\*(.+?)\*\*/g;
    let match = re.exec(value);
    while (match) {
      const before = value.slice(lastIndex, match.index);
      plain += before;
      plainCursor += before.length;

      const boldText = match[1];
      const start = plainCursor;
      plain += boldText;
      plainCursor += boldText.length;
      const end = plainCursor;
      boldRanges.push({ start, end });

      lastIndex = match.index + match[0].length;
      match = re.exec(value);
    }

    const tail = value.slice(lastIndex);
    plain += tail;
    return { plain, boldRanges };
  };

  const headingLevelToStyle = (level) => {
    if (level <= 1) return "HEADING_1";
    if (level === 2) return "HEADING_2";
    return "HEADING_3";
  };

  const addParagraphStyle = (start, end, namedStyleType) => {
    requests.push({
      updateParagraphStyle: {
        range: { startIndex: start, endIndex: end },
        paragraphStyle: {
          namedStyleType,
          spaceAbove: { magnitude: namedStyleType === "NORMAL_TEXT" ? 0 : 6, unit: "PT" },
          spaceBelow: { magnitude: namedStyleType === "NORMAL_TEXT" ? 3 : 5, unit: "PT" }
        },
        fields: "namedStyleType,spaceAbove,spaceBelow"
      }
    });
  };

  const addTextStyle = (start, end, { bold = false, size = 12 } = {}) => {
    // Google Docs rejects empty ranges (startIndex === endIndex).
    if (end <= start) return;
    requests.push({
      updateTextStyle: {
        range: { startIndex: start, endIndex: end },
        textStyle: {
          bold,
          weightedFontFamily: { fontFamily: "Nunito" },
          fontSize: { magnitude: size, unit: "PT" }
        },
        fields: "bold,weightedFontFamily,fontSize"
      }
    });
  };

  lines.forEach((rawLine) => {
    const line = rawLine || "";
    if (/^\s*-{3,}\s*$/.test(line)) {
      return;
    }
    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    const numberedMatch = line.match(/^\d+\.\s+(.*)$/);

    const start = cursor;
    let content = line;
    let isHeading = false;
    let headingLevel = 0;
    let bulletPreset = "";

    if (headingMatch) {
      isHeading = true;
      headingLevel = headingMatch[1].length;
      content = headingMatch[2].trim();
    } else if (bulletMatch) {
      content = bulletMatch[1].trim();
      bulletPreset = "BULLET_DISC_CIRCLE_SQUARE";
    } else if (numberedMatch) {
      // Keep explicit numbering text for stable formatting.
      content = line.trim();
    }

    const parsed = parseInlineBold(content);
    content = parsed.plain;
    const inlineBoldRanges = parsed.boldRanges;

    const lineText = `${content}\n`;
    text += lineText;
    cursor += lineText.length;
    const end = cursor;

    const hasVisibleText = content.trim().length > 0;

    if (isHeading) {
      const style = headingLevelToStyle(headingLevel);
      addParagraphStyle(start, end, style);
      const size = headingLevel <= 1 ? 20 : headingLevel === 2 ? 17 : 15;
      if (hasVisibleText) addTextStyle(start, end - 1, { bold: true, size });
      return;
    }

    addParagraphStyle(start, end, "NORMAL_TEXT");
    if (hasVisibleText) addTextStyle(start, end - 1, { bold: false, size: 12 });
    inlineBoldRanges.forEach((r) => {
      addTextStyle(start + r.start, start + r.end, { bold: true, size: 12 });
    });

    if (bulletPreset) {
      requests.push({
        createParagraphBullets: {
          range: { startIndex: start, endIndex: end },
          bulletPreset
        }
      });
    }
  });

  return { text, requests };
}

function normalizePrivateKey(privateKeyRaw) {
  if (!privateKeyRaw) return "";

  // Support both escaped newlines from .env and literal multiline keys.
  let key = privateKeyRaw.trim().replace(/\\n/g, "\n");

  // Some environments load only the base64 body without PEM wrappers.
  if (!key.includes("BEGIN PRIVATE KEY")) {
    key = `-----BEGIN PRIVATE KEY-----\n${key}\n-----END PRIVATE KEY-----\n`;
  }

  return key;
}

function getGoogleAuth() {
  const oauthClientId = (process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
  const oauthClientSecret = (process.env.GOOGLE_OAUTH_CLIENT_SECRET || "").trim();
  const oauthRefreshToken = (process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "").trim();
  if (oauthClientId && oauthClientSecret && oauthRefreshToken) {
    const oauth2Client = new google.auth.OAuth2(oauthClientId, oauthClientSecret);
    oauth2Client.setCredentials({ refresh_token: oauthRefreshToken });
    return { auth: oauth2Client, mode: "oauth_user" };
  }

  const clientEmail = (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "").trim();
  const privateKeyRaw = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKeyRaw) return null;

  const privateKey = normalizePrivateKey(privateKeyRaw);
  return {
    auth: new google.auth.JWT({
      email: clientEmail,
      key: privateKey,
      scopes: [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/drive"
      ]
    }),
    mode: "service_account"
  };
}

function buildGoogleSetupHint(authMode) {
  if (authMode === "oauth_user") {
    return "Google OAuth token lacks permission for this folder/project. Reconnect OAuth credentials or choose a folder your Google account can edit.";
  }

  return "Verify this folder is shared with your service account as Editor and Docs API/Drive API are enabled in the same project.";
}

function buildNotConfiguredMessage() {
  return (
    "Google Docs credentials not configured. Configure OAuth user auth " +
    "(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN) " +
    "or service-account auth (GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY)."
  );
}

export async function createGoogleDocFromMarkdown({ title, markdown }) {
  const authContext = getGoogleAuth();
  if (!authContext) {
    return { enabled: false, reason: buildNotConfiguredMessage() };
  }
  const { auth, mode } = authContext;

  const docs = google.docs({ version: "v1", auth });
  const drive = google.drive({ version: "v3", auth });
  const folderId = (process.env.GOOGLE_DRIVE_FOLDER_ID || "").trim();

  let docId = "";
  try {
    // Prefer Drive creation because it allows targeting a shared folder directly.
    const createRes = await drive.files.create({
      requestBody: {
        name: title,
        mimeType: "application/vnd.google-apps.document",
        ...(folderId
          ? { parents: [folderId] }
          : {})
      },
      fields: "id, webViewLink",
      supportsAllDrives: true
    });
    docId = createRes.data.id || "";
  } catch (error) {
    const status = error?.response?.status;
    const reason = error?.response?.data?.error?.errors?.[0]?.reason; 
    if (reason === "storageQuotaExceeded" && mode === "service_account") {
      throw new Error(
        "Google blocked file creation for this service account (no storage quota). Configure OAuth user auth in .env (GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN), or use a Shared Drive."
      );
    }
    if (status === 403) {
      throw new Error(`Google permission denied (403). ${buildGoogleSetupHint(mode)}`);
    }
    throw error;
  }

  if (!docId) throw new Error("Failed to create Google Doc.");

  const { text, requests } = buildDocRequestsFromMarkdown(markdown);
  await docs.documents.batchUpdate({
    documentId: docId,
    requestBody: {
      requests: [
        {
          insertText: {
            location: { index: 1 },
            text
          }
        },
        ...requests
      ]
    }
  });

  const shareWithEmail = (process.env.GOOGLE_SHARE_WITH_EMAIL || "").trim();
  if (shareWithEmail) {
    await drive.permissions.create({
      fileId: docId,
      requestBody: {
        type: "user",
        role: "writer",
        emailAddress: shareWithEmail
      },
      sendNotificationEmail: false,
      supportsAllDrives: true
    });
  }

  return {
    enabled: true,
    docId, 
    url: `https://docs.google.com/document/d/${docId}/edit`
  };
}
const isPublic = (process.env.GOOGLE_DOC_PUBLIC_ACCESS || "").toLowerCase() === "true";
if (isPublic) {
  const publicRole = (process.env.GOOGLE_DOC_PUBLIC_ROLE || "reader").toLowerCase();
  await drive.permissions.create({
    fileId: docId,
    requestBody: {
      type: "anyone",
      role: publicRole === "writer" ? "writer" : "reader"
    },
    supportsAllDrives: true
  });
}