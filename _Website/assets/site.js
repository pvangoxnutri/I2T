(() => {
  'use strict';
  document.documentElement.classList.add('js');
  const $ = id => document.getElementById(id);
  const form = $('request-form');
  const inquiry = $('inquiry');
  const message = $('message');
  const status = $('inquiry-status');
  const submit = $('submit-inquiry');
  const fields = $('inquiry-fields');
  const calcCount = $('calc-transitions');
  const assembly = $('calc-assembly');
  /**
   * THE PRICE, IN ONE PLACE.
   *
   * Every number the page quotes comes from here and from `quote()` below
   * — the calculator, its breakdown, the message the pricing CTA drafts
   * and the summary the form sends. A second copy of the surcharge is how
   * a page ends up showing one total and emailing another.
   */
  const PRICING = Object.freeze({
    transition: 5,
    assembly: 10,
    /** Premium Smooth is +10% of the WHOLE service price, not of one part. */
    premiumSmoothMultiplier: 1.10
  });

  /** The two motion levels, and what the customer is told about each. */
  const QUALITY = Object.freeze({
    standard60: { label: 'Standard', fps: 60, summary: 'Standard — 60 FPS' },
    premium120: { label: 'Premium Smooth', fps: 120, summary: 'Premium Smooth — 120 FPS (+10%)' }
  });

  /**
   * What a given selection costs.
   *
   * Cents, not floats, for the surcharge: 10% of €55 is €5.50 and
   * `55 * 1.1` is 60.50000000000001. Rounding at the end of a chain of
   * binary fractions is what puts a stray cent on an invoice.
   */
  function quote(transitions, withAssembly, quality) {
    const base = transitions * PRICING.transition + (withAssembly ? PRICING.assembly : 0);
    const baseCents = Math.round(base * 100);
    const totalCents = quality === 'premium120'
      ? Math.round(baseCents * PRICING.premiumSmoothMultiplier)
      : baseCents;
    return {
      transitionsCost: transitions * PRICING.transition,
      assemblyCost: withAssembly ? PRICING.assembly : 0,
      base,
      surcharge: (totalCents - baseCents) / 100,
      total: totalCents / 100
    };
  }

  const euro = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  /** The surcharge is rarely a whole euro, so it gets cents. */
  const euroExact = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
  const money = (n) => (Number.isInteger(n) ? euro.format(n) : euroExact.format(n));
  const types = new Set(['video', 'agency', 'partnership', 'other']);
  let sending = false;
  let attemptId = null;

  function countOf() {
    const n = calcCount.valueAsNumber;
    return calcCount.validity.valid && Number.isSafeInteger(n) && n >= 1
      && Number.isSafeInteger(n * PRICING.transition + PRICING.assembly) ? n : null;
  }
  /** Which smoothness the calculator is quoting. Standard unless chosen. */
  function selectedQuality() {
    const picked = document.querySelector('input[name="calcQuality"]:checked');
    return picked && picked.value === 'premium120' ? 'premium120' : 'standard60';
  }
  function updateQuote() {
    const count = countOf();
    const quality = selectedQuality();
    const q = count === null ? null : quote(count, assembly.checked, quality);
    $('calc-total').textContent = q === null ? '—' : money(q.total);
    // The breakdown exists so the surcharge is a line the customer can
    // see and check, not a number that silently appeared in the total.
    $('calc-line-transitions').textContent = q === null ? '—' : money(q.transitionsCost);
    $('calc-line-assembly').textContent = q === null ? '—' : money(q.assemblyCost);
    $('calc-line-premium').textContent = q === null ? '—' : money(q.surcharge);
    $('calc-premium-row').hidden = quality !== 'premium120';
    $('calc-error').hidden = count !== null;
    $('decrease').disabled = count !== null && count <= 1;
    // The form's own selector follows the calculator, so a visitor who
    // priced Premium does not then send a Standard inquiry by accident.
    const formQuality = document.querySelector(`input[name="motionQuality"][value="${quality}"]`);
    if (formQuality) formQuality.checked = true;
  }
  for (const input of [calcCount, assembly]) input.addEventListener('input', updateQuote);
  document.querySelectorAll('input[name="calcQuality"]').forEach((radio) =>
    radio.addEventListener('change', updateQuote)
  );
  $('decrease').addEventListener('click', () => { calcCount.value = String(Math.max(1, (countOf() ?? 2) - 1)); updateQuote(); });
  $('increase').addEventListener('click', () => {
    const next = (countOf() ?? 0) + 1;
    if (Number.isSafeInteger(next * PRICING.transition + PRICING.assembly)) calcCount.value = String(next);
    updateQuote();
  });

  function clearFeedback() {
    if (sending) return;
    status.hidden = true;
    status.textContent = '';
    attemptId = null;
  }
  form.addEventListener('input', clearFeedback);
  form.addEventListener('change', clearFeedback);
  document.querySelectorAll('[data-inquiry]').forEach(link => link.addEventListener('click', () => {
    if (sending) return;
    inquiry.value = types.has(link.dataset.inquiry) ? link.dataset.inquiry : 'other';
    clearFeedback();
    // The pricing CTA carries its estimate in the visible message, without
    // overwriting a visitor's existing draft or expanding the small form.
    if (link.closest('.calculator') && !message.value.trim() && countOf() !== null) {
      message.value = `Video request: ${countOf()} transitions. Full video assembly: ${assembly.checked ? 'yes' : 'no'}. Video smoothness: ${QUALITY[selectedQuality()].summary}. Estimated total: ${$('calc-total').textContent}.\n\n`;
    }
    if (link.getAttribute('href') === '#contact') $('name').focus({ preventScroll: true });
  }));

  const menu = $('navigation');
  const menuButton = document.querySelector('.menu-toggle');
  function closeMenu() { menu.classList.remove('is-open'); menuButton.setAttribute('aria-expanded', 'false'); }
  menuButton.addEventListener('click', () => menuButton.setAttribute('aria-expanded', String(menu.classList.toggle('is-open'))));
  menu.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && menu.classList.contains('is-open')) { closeMenu(); menuButton.focus(); }
  });

  function showStatus(text, state) {
    status.textContent = text;
    status.dataset.state = state;
    status.hidden = false;
    status.focus({ preventScroll: true });
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (sending) return;
    for (const input of form.querySelectorAll('input, textarea')) input.value = input.value.trim();
    if (!form.reportValidity()) return;
    if (location.protocol === 'file:') {
      showStatus('Please open the website through the local server to send an inquiry, or email contact@image2transition.com.', 'error');
      return;
    }
    const data = Object.fromEntries(new FormData(form));
    // Reuse this identifier after an ambiguous timeout, preventing a duplicate
    // send at Resend. Editing the form starts a new submission attempt.
    attemptId ||= crypto.randomUUID();
    sending = true;
    fields.disabled = true;
    submit.disabled = true;
    submit.textContent = 'Sending…';
    form.setAttribute('aria-busy', 'true');
    status.hidden = true;
    try {
      const response = await fetch('/api/inquiry', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attemptId },
        body: JSON.stringify(data), signal: AbortSignal.timeout(15_000)
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) {
        // Never render backend/provider messages or diagnostic details.
        const feedback = response.status === 429
          ? 'Please wait a few minutes before sending another inquiry.'
          : response.status === 400
            ? 'Please check your name, email address and message, then try again.'
            : 'We couldn’t send your inquiry. Please try again or email contact@image2transition.com.';
        showStatus(feedback, 'error');
        return;
      }
      form.reset();
      attemptId = null;
      showStatus('Thank you. Your inquiry has been sent. We’ll reply to the email address you provided.', 'success');
    } catch {
      showStatus('We couldn’t confirm your inquiry was sent. Please try again or email contact@image2transition.com.', 'error');
    } finally {
      sending = false;
      fields.disabled = false;
      submit.disabled = false;
      submit.textContent = 'Send inquiry ↗';
      form.removeAttribute('aria-busy');
    }
  });

  const videos = [...document.querySelectorAll('video')];
  for (const video of videos) {
    const reportError = () => {
      $('video-status').hidden = false;
      $('video-status').textContent = 'A demo could not load. Please reload the page or open its video link.';
    };
    video.addEventListener('error', reportError);
    video.querySelector('source').addEventListener('error', reportError);
  }
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function respectMotion() { if (reducedMotion.matches) videos.forEach(video => { video.autoplay = false; video.pause(); }); }
  reducedMotion.addEventListener('change', respectMotion);
  respectMotion();
  updateQuote();
})();
