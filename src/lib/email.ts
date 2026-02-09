/**
 * Transactional email templates for S3 Admin.
 *
 * All templates use inline styles for maximum email-client compatibility.
 * Colour palette matches the app: neutral/monochrome with a dark primary button.
 */

const BRAND = "S3 Admin"
const DOMAIN = "s3administrator.com"
const SUPPORT_EMAIL = `support@${DOMAIN}`

// ─── Shared layout ──────────────────────────────────────

function layout(content: string) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${BRAND}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5;padding:40px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.08);">
          <!-- Header -->
          <tr>
            <td style="padding:32px 40px 0 40px;">
              <p style="margin:0;font-size:18px;font-weight:700;color:#111111;letter-spacing:-0.3px;">${BRAND}</p>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:24px 40px 32px 40px;">
              ${content}
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="padding:24px 40px;border-top:1px solid #e4e4e7;">
              <p style="margin:0 0 4px 0;font-size:12px;color:#a1a1aa;">
                ${BRAND} &mdash; Open source S3 file manager for any provider.
              </p>
              <p style="margin:0;font-size:12px;color:#a1a1aa;">
                <a href="https://www.${DOMAIN}" style="color:#71717a;text-decoration:underline;">www.${DOMAIN}</a>
              </p>
            </td>
          </tr>
        </table>
        <!-- Unsubscribe / legal line -->
        <p style="margin:24px 0 0 0;font-size:11px;color:#a1a1aa;text-align:center;">
          Questions? Contact <a href="mailto:${SUPPORT_EMAIL}" style="color:#71717a;">${SUPPORT_EMAIL}</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`
}

function button(text: string, href: string) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="background-color:#111111;border-radius:8px;">
          <a href="${href}" target="_blank" style="display:inline-block;padding:12px 32px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;letter-spacing:0.2px;">
            ${text}
          </a>
        </td>
      </tr>
    </table>`
}

// ─── Templates ───────────────────────────────────────────

export function signInEmail(url: string) {
  return {
    subject: `Sign in to ${BRAND}`,
    html: layout(`
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:700;color:#111111;">Sign in to your account</h1>
      <p style="margin:0;font-size:15px;color:#52525b;line-height:1.6;">
        Click the button below to securely sign in. This link is valid for 24 hours and can only be used once.
      </p>
      ${button("Sign In", url)}
      <p style="margin:0;font-size:13px;color:#a1a1aa;line-height:1.5;">
        If you didn&rsquo;t request this email, you can safely ignore it. No account changes will be made.
      </p>
    `),
  }
}

export function welcomeEmail(name?: string | null) {
  const greeting = name ? `Hi ${name},` : "Welcome,"
  return {
    subject: `Welcome to ${BRAND}`,
    html: layout(`
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:700;color:#111111;">Welcome aboard</h1>
      <p style="margin:0 0 16px 0;font-size:15px;color:#52525b;line-height:1.6;">
        ${greeting} your account is ready. You can now connect your S3-compatible storage and start managing your files.
      </p>
      <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 24px 0;">
        <tr>
          <td style="padding:16px;background-color:#fafafa;border-radius:8px;">
            <p style="margin:0 0 8px 0;font-size:14px;font-weight:600;color:#111111;">Getting started</p>
            <ol style="margin:0;padding:0 0 0 20px;font-size:14px;color:#52525b;line-height:1.8;">
              <li>Go to <strong>Settings</strong> and add your S3 credentials</li>
              <li>Browse, upload, and manage your files from the <strong>Dashboard</strong></li>
              <li>Upgrade your plan anytime from <strong>Billing</strong></li>
            </ol>
          </td>
        </tr>
      </table>
      ${button("Open Dashboard", `https://www.${DOMAIN}/dashboard`)}
    `),
  }
}

export function subscriptionConfirmEmail(planName: string) {
  return {
    subject: `${BRAND} — You're on ${planName}`,
    html: layout(`
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:700;color:#111111;">Subscription confirmed</h1>
      <p style="margin:0 0 16px 0;font-size:15px;color:#52525b;line-height:1.6;">
        You&rsquo;re now on the <strong>${planName}</strong> plan. Your new limits and features are active immediately.
      </p>
      <p style="margin:0 0 24px 0;font-size:14px;color:#52525b;line-height:1.6;">
        You can manage your subscription, update payment methods, or view invoices from the billing page.
      </p>
      ${button("Manage Billing", `https://www.${DOMAIN}/billing`)}
    `),
  }
}

export function subscriptionCanceledEmail(planName: string, endsAt: string) {
  return {
    subject: `${BRAND} — ${planName} cancellation confirmed`,
    html: layout(`
      <h1 style="margin:0 0 8px 0;font-size:22px;font-weight:700;color:#111111;">Cancellation confirmed</h1>
      <p style="margin:0 0 16px 0;font-size:15px;color:#52525b;line-height:1.6;">
        Your <strong>${planName}</strong> plan has been canceled. You&rsquo;ll continue to have access to all features until <strong>${endsAt}</strong>.
      </p>
      <p style="margin:0 0 24px 0;font-size:14px;color:#52525b;line-height:1.6;">
        Changed your mind? You can re-subscribe anytime before your access expires.
      </p>
      ${button("Re-subscribe", `https://www.${DOMAIN}/billing`)}
    `),
  }
}
