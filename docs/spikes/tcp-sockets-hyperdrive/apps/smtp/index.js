import * as Smtp from "@portable/smtp";
import { connect } from "cloudflare:sockets";
export default {
  async fetch(req) {
    const url = new URL(req.url);
    const mode = url.searchParams.get("mode") || "plain";
    const out = {};
    try {
      const base = { connect, host: "localhost", port: 51025, secure: mode === "plain" ? "off" : "starttls" };
      const opts = mode === "auth" ? { ...base, auth: { user: "u", pass: "p" }, secure: "starttls" } : base;
      const result = await Smtp.send(
        {
          from: "me@example.com",
          to: ["you@example.com"],
          message:
            "Subject: spike " + mode + "\r\nFrom: me@example.com\r\nTo: you@example.com\r\n\r\nHello " + mode + "\r\n",
        },
        opts,
      );
      out.accepted = result.accepted;
      out.rejected = result.rejected;
      out.response = result.response;
    } catch (e) {
      out.err = String(e && e.name) + ": " + String(e && e.message);
    }
    return new Response(JSON.stringify(out));
  },
};
