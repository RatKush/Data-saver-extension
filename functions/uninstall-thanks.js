// POST /uninstall-thanks — records uninstall feedback, then redirects to the
// static docs/uninstall-thanks.html. GET is not handled here, so Pages serves
// that page directly with the headers in docs/_headers.
//
// Two posts arrive here:
//   1. a reason button on docs/uninstall.html  -> insert a row,
//      303 to /uninstall-thanks?id=<row>#<reason> (the fix for that reason)
//   2. the optional note on the thank-you page, which has no form action and
//      so posts back to ?id=<row>              -> attach it, 303 to #noted
//
// Stored: the reason, the note, the extension version and Cloudflare's
// country code. No IP address and no identifier — docs/privacy-policy.html
// says exactly that, so adding a column here means editing it too.
//
// The table lives in the same D1 database as the ad blocker's licence
// server (see wrangler.toml), tagged product = 'data-saver', so one admin
// endpoint reads feedback for both products.

const REASONS = new Set(['site-broke', 'video', 'login', 'slow', 'no-savings', 'other']);
const NOTE_MAX = 1000;
const EDIT_WINDOW_MS = 60 * 60 * 1000;
const ID_RE = /^[0-9a-f-]{36}$/;

const back = (location) => new Response(null, { status: 303, headers: { Location: location } });

// The reason page is opened as /uninstall?v=<version>, and a same-origin form
// post carries that full URL as its Referer, so the version needs no script.
function versionFrom(request) {
  try {
    const v = new URL(request.headers.get('Referer') || '').searchParams.get('v') || '';
    return /^\d+(\.\d+){0,3}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  let form;
  try {
    form = await request.formData();
  } catch {
    return back('/uninstall');
  }
  const now = Date.now();

  try {
    const note = String(form.get('note') || '').trim().slice(0, NOTE_MAX);
    if (note) {
      const id = url.searchParams.get('id') || '';
      if (ID_RE.test(id)) {
        const { meta } = await env.DB.prepare(
          `UPDATE feedback SET comment = ?, updated_at = ?
            WHERE id = ? AND product = 'data-saver' AND created_at > ?`
        ).bind(note, now, id, now - EDIT_WINDOW_MS).run();
        if (meta?.changes) return back('/uninstall-thanks#noted');
      }
      // No usable row to attach it to (expired, or the page was opened
      // directly): keep the note anyway, as its own row.
      await env.DB.prepare(
        `INSERT INTO feedback (id, product, reason, comment, version, country, created_at, updated_at)
         VALUES (?, 'data-saver', 'other', ?, NULL, ?, ?, ?)`
      ).bind(crypto.randomUUID(), note, request.cf?.country ?? null, now, now).run();
      return back('/uninstall-thanks#noted');
    }

    const reason = String(form.get('reason') || '');
    if (!REASONS.has(reason)) return back('/uninstall');
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO feedback (id, product, reason, comment, version, country, created_at, updated_at)
       VALUES (?, 'data-saver', ?, NULL, ?, ?, ?, ?)`
    ).bind(id, reason, versionFrom(request), request.cf?.country ?? null, now, now).run();
    return back(`/uninstall-thanks?id=${id}#${reason}`);
  } catch (err) {
    console.log(`feedback write failed: ${err?.message ?? err}`);
    return back('/uninstall-thanks#failed');
  }
}
