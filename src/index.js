import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import PostalMime from "postal-mime";
// import EmailReplyParser from "email-reply-parser";

const ALLOWED_SENDER = "you@yourdomain.com"; // Replace with your email address
const SYSTEM_PROMPT = "You are a helpful email assistant. Keep replies clear and concise.";

// ============================================================================
// Encoding & Attachment Helpers
// ============================================================================

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function stringToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function extractAttachments(attachments = []) {
  const textAttachments = [];
  const binaryAttachments = [];

  for (const file of attachments) {
    // Skip files larger than 5MB to stay within Worker memory limits
    if (!file.content || file.content.byteLength > 5 * 1024 * 1024) continue;

    if (
      file.mimeType.startsWith("text/") ||
      file.mimeType === "application/json" ||
      file.mimeType === "application/csv"
    ) {
      const decodedText = new TextDecoder("utf-8").decode(file.content);
      textAttachments.push(`--- Attachment: ${file.filename || "file"} ---\n${decodedText}`);
    } else if (
      file.mimeType.startsWith("image/") ||
      file.mimeType === "application/pdf"
    ) {
      binaryAttachments.push({
        filename: file.filename || "attachment",
        mimeType: file.mimeType,
        base64: arrayBufferToBase64(file.content),
      });
    }
  }

  return { textAttachments, binaryAttachments };
}

function stripQuotedText(text) {
  return text
    // Strip "On <date>, <sender> wrote:" reply headers (handles multi-line wrapping)
    .replace(/\r?\nOn [\s\S]*?wrote:\r?\n[\s\S]*/i, "")
    // Strip Outlook-style "-----Original Message-----" and "From: ..." blocks
    .replace(/\r?\n-{2,}\s*Original Message\s*-{2,}[\s\S]*/i, "")
    .replace(/\r?\nFrom:\s.*[\s\S]*/i, "")
    // Strip standard "-- " email signatures
    .replace(/\r?\n-- \r?\n[\s\S]*/i, "")
    // Remove any remaining ">" quoted lines
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith(">"))
    .join("\n")
    .trim();
}


// ============================================================================
// Pre-Approved AI Providers
// ============================================================================

const PROVIDERS = {
  llama: async (messages, binaryAttachments, env) => {
    const res = await env.AI.run("@cf/mistral/mistral-7b-instruct-v0.2-lora", {
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
    });
    return res.response;
  },

  openai: async (messages, binaryAttachments, env) => {
    const formattedMessages = messages.map((m, idx) => {
      if (idx === messages.length - 1 && m.role === "user" && binaryAttachments.length > 0) {
        const contentParts = [{ type: "text", text: m.content }];
        for (const file of binaryAttachments) {
          if (file.mimeType.startsWith("image/")) {
            contentParts.push({
              type: "image_url",
              image_url: { url: `data:${file.mimeType};base64,${file.base64}` },
            });
          }
        }
        return { role: "user", content: contentParts };
      }
      return m;
    });

    const res = await fetch("https://openai.com", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...formattedMessages],
      }),
    });

    if (!res.ok) throw new Error(`OpenAI API error (${res.status})`);
    const data = await res.json();
    return data.choices[0].message.content;
  },

  gemini: async (messages, binaryAttachments, env) => {
    const contents = messages.map((m, idx) => {
      const parts = [{ text: m.content }];

      if (idx === messages.length - 1 && m.role === "user" && binaryAttachments.length > 0) {
        for (const file of binaryAttachments) {
          parts.push({
            inlineData: {
              mimeType: file.mimeType,
              data: file.base64,
            },
          });
        }
      }

      return {
        role: m.role === "assistant" ? "model" : "user",
        parts,
      };
    });

    const res = await fetch(
      `https://googleapis.com{env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents,
        }),
      }
    );

    if (!res.ok) throw new Error(`Gemini API error (${res.status})`);
    const data = await res.json();
    return data.candidates[0].content.parts[0].text;
  },
};

// ============================================================================
// Main Cloudflare Email Handler
// ============================================================================

export default {
  async email(message, env, ctx) {
    const sender = message.from;
    const recipient = message.to;

    // 1. Security & Infinite Loop Prevention (supports comma-separated list in env)
    const allowedSenders = (env.ALLOWED_SENDERS || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean);

    if (!allowedSenders.includes(sender.toLowerCase())) {
      console.warn(`Blocked unauthorised sender: ${sender}`);
      return;
    }

    const autoSubmitted = message.headers.get("auto-submitted");
    if (sender === recipient || (autoSubmitted && autoSubmitted !== "no")) {
      return;
    }


    // 2. Parse Raw Email & Strip Quoted Thread History
    const rawEmail = await new Response(message.raw).arrayBuffer();
    const parsedEmail = await new PostalMime().parse(rawEmail);
    const rawSubject = parsedEmail.subject || "No Subject";

    const rawText = parsedEmail.text || "";
    const latestReply = stripQuotedText(rawText);
    let userText = latestReply || rawText.trim();
    console.log("user text:", userText);


    // 3. Extract Inbound Attachments
    const { textAttachments, binaryAttachments } = extractAttachments(parsedEmail.attachments);
    if (textAttachments.length > 0) {
      userText += `\n\n${textAttachments.join("\n\n")}`;
    }

    // 4. Retrieve Thread State from Cloudflare KV
    const incomingMessageId = message.headers.get("message-id") || `<${crypto.randomUUID()}@worker>`;
    const existingReferences = message.headers.get("references");
    const rootThreadId = existingReferences
      ? existingReferences.trim().split(/\s+/)[0]
      : incomingMessageId;

    const threadState = (await env.EMAIL_MEMORY.get(rootThreadId, "json")) || {
      provider: "llama",
      history: [],
    };

    // 5. Parse Dynamic Commands (/provider and /file)
    let requestedFileExt = null;
    let parsingCommands = true;

    while (parsingCommands) {
      const providerMatch = userText.match(/^\/(llama|openai|gemini)\b\s*/i);
      const fileMatch = userText.match(/^\/file\s+(csv|md|json|txt)\b\s*/i);

      if (providerMatch) {
        threadState.provider = providerMatch[1].toLowerCase();
        userText = userText.slice(providerMatch[0].length).trim();
      } else if (fileMatch) {
        requestedFileExt = fileMatch[1].toLowerCase();
        userText = userText.slice(fileMatch[0].length).trim();
      } else {
        parsingCommands = false;
      }
    }

    if (requestedFileExt) {
      userText += `\n\nIMPORTANT: Output ONLY valid raw ${requestedFileExt.toUpperCase()} content. Do not include markdown code fences (\`\`\`) or conversational filler.`;
    }

    if (!userText && binaryAttachments.length === 0) {
      userText = "Please summarise the attached files.";
    }

    // 6. Update Conversation History (Keep Last 20 Turns)
    threadState.history.push({ role: "user", content: userText });
    if (threadState.history.length > 20) {
      threadState.history = threadState.history.slice(-20);
    }

    // 7. Execute AI Provider Request
    let replyBody = "Sorry, I couldn't process your request right now.";
    let aiSucceeded = false;

    try {
      replyBody = await PROVIDERS[threadState.provider](
        threadState.history,
        binaryAttachments,
        env
      );
      threadState.history.push({ role: "assistant", content: replyBody });
      aiSucceeded = true;
    } catch (error) {
      console.error(`Provider (${threadState.provider}) failed:`, error);
      replyBody = `Error calling ${threadState.provider}: ${error.message}`;
      threadState.history.pop(); // Roll back failed turn
    }

    // 8. Persist Updated Thread State to KV (30-Day TTL)
    await env.EMAIL_MEMORY.put(rootThreadId, JSON.stringify(threadState), {
      expirationTtl: 60 * 60 * 24 * 30,
    });

    // 9. Build Threaded MIME Reply
    const replySubject = /^re:/i.test(rawSubject) ? rawSubject : `Re: ${rawSubject}`;
    console.log("reply subject:", replySubject);
    const msg = createMimeMessage();
    msg.setSender({ name: `AI Assistant (${threadState.provider})`, addr: recipient });
    msg.setRecipient(sender);
    msg.setSubject(replySubject);

    msg.setHeader("In-Reply-To", incomingMessageId);
    const referencesChain = existingReferences
      ? `${existingReferences} ${incomingMessageId}`
      : incomingMessageId;
    msg.setHeader("References", referencesChain);

    if (requestedFileExt && aiSucceeded) {
      const mimeTypes = {
        csv: "text/csv",
        md: "text/markdown",
        json: "application/json",
        txt: "text/plain",
      };

      const cleanFileContent = replyBody
        .replace(/^```[a-z]*\r?\n/i, "")
        .replace(/\r?\n```$/i, "")
        .trim();

      msg.addAttachment({
        filename: `ai-output.${requestedFileExt}`,
        contentType: mimeTypes[requestedFileExt],
        data: stringToBase64(cleanFileContent),
      });

      msg.addMessage({
        contentType: "text/plain",
        data: `Attached is your generated ai-output.${requestedFileExt} file.`,
      });
    } else {
      msg.addMessage({
        contentType: "text/plain",
        data: replyBody,
      });
      console.log("reply body text", replyBody);
    }

    // 10. Send Outbound Email
    await env.EMAIL.send(new EmailMessage(recipient, sender, msg.asRaw()));
},
};
