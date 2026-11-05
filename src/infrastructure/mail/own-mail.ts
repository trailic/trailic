import { bearerJson, requestJson } from "../http/provider";
import type { Env } from "../env";

type OwnMailSettings = Pick<Env, "RESEND_API_KEY" | "TRAILIC_MAIL_FROM">;

const EMAILS = "https://api.resend.com/emails";

/** Whether this instance can send its own mail at all. */
export const hasOwnMail = (settings: Pick<Env, "RESEND_API_KEY">) => Boolean(settings.RESEND_API_KEY);

/**
 * The instance's own mail to its members, through Resend (https://resend.com/docs/api-reference/emails/send-email):
 * sign-in links and invitations. An instance without a key simply sends none of its own.
 */
export async function sendOwnMail(settings: OwnMailSettings, fetchUrl: typeof fetch, mail: { to: string; subject: string; text: string }): Promise<boolean> {
  if (!settings.RESEND_API_KEY) return false;
  await requestJson(fetchUrl, "Resend", EMAILS, {
    method: "POST",
    headers: bearerJson(settings.RESEND_API_KEY),
    body: JSON.stringify({ from: settings.TRAILIC_MAIL_FROM, to: [mail.to], subject: mail.subject, text: mail.text }),
  });
  return true;
}
