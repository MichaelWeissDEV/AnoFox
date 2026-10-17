import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyButton, normalizeLabel } from '../src/protection/consent/labels.ts';
import { ADAPTERS, getAdapter } from '../src/protection/consent/adapters.ts';
import { effectiveConsentMode } from '../src/protection/consent/mode.ts';
import { isSafeSelector } from '../src/protection/adblock/cosmetic.ts';

test('refusal labels in several languages are "reject"', () => {
  for (const l of ['Reject all', 'Decline', 'DISAGREE', 'Deny', 'Refuse all', 'Only necessary cookies', 'Necessary cookies only', 'Accept only necessary cookies',
    'Continue without accepting', 'Alle ablehnen', 'Nur notwendige Cookies', 'Nur erforderliche akzeptieren', 'Weiter ohne Zustimmung',
    'Tout refuser', 'Uniquement les cookies nécessaires', 'Continuer sans accepter', 'Rechazar todo', 'Solo cookies necesarias',
    'Rifiuta tutto', 'Solo necessari', 'Alles weigeren', 'Alleen noodzakelijke cookies', 'Rejeitar tudo', 'Odrzuć wszystkie']) {
    assert.equal(classifyButton(l), 'reject', l);
  }
});

test('consent-granting labels are never "reject"', () => {
  for (const l of ['Accept all', 'I agree', 'Allow all cookies', 'OK', 'Got it', 'Alle akzeptieren', 'Zustimmen', 'Einverstanden', 'Tout accepter',
    "J'accepte", 'Aceptar todo', 'Accetta tutto', 'Alles accepteren', 'Aceitar tudo', 'Accept & continue']) {
    assert.equal(classifyButton(l), 'accept', l);
  }
});

test('neutral controls are "other" and therefore never clicked', () => {
  for (const l of ['Settings', 'Customize', 'Manage preferences', 'Learn more', 'Einstellungen', 'Datenschutzerklärung', 'Mehr erfahren', '', '   ', 'Menu', 'Subscribe']) {
    assert.equal(classifyButton(l), 'other', JSON.stringify(l));
  }
});

test('label normalisation strips diacritics, punctuation and length', () => {
  assert.equal(normalizeLabel('  Nécessaires   UNIQUEMENT!! '), 'necessaires uniquement');
  assert.ok(normalizeLabel('x'.repeat(500)).length <= 120);
});

test('adapter data: unique ids, safe selectors, refusal-only flows, no accept controls anywhere', () => {
  const ids = ADAPTERS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ADAPTERS.at(-1)!.id, 'generic', 'the heuristic detector runs last');
  for (const a of ADAPTERS) {
    for (const sel of a.containers) assert.ok(isSafeSelector(sel), `${a.id} container ${sel}`);
    for (const flow of a.rejectFlows) {
      assert.ok(flow.length > 0);
      // "save selection" controls may carry vendor names like AllowallSelection, but only after every optional purpose was unchecked
      const unchecksFirst = flow[0].kind === 'uncheckAll';
      for (const step of flow) {
        if (step.kind !== 'wait') assert.ok(isSafeSelector(step.selector), `${a.id} ${step.selector}`);
        if (step.kind === 'click' && !unchecksFirst) assert.doesNotMatch(step.selector, /accept|(?<!dis)agree|allow-?all|allowall(?!selection)|opt-?in-?all/i, `${a.id}: "${step.selector}" looks like an accept control`);
      }
      const last = flow.filter((s) => s.kind !== 'wait').at(-1)!;
      assert.equal(last.kind, 'click', `${a.id}: a flow must end with a click`);
    }
  }
  assert.ok(getAdapter('onetrust') && getAdapter('cookiebot') && getAdapter('usercentrics') && getAdapter('klaro'));
  assert.equal(getAdapter('usercentrics')!.shadowHost, '#usercentrics-root');
});

test('modes: module off beats everything, auto means reject, nothing ever maps to accept', () => {
  assert.equal(effectiveConsentMode('auto', 'off'), 'manual');
  assert.equal(effectiveConsentMode('reject', 'off'), 'manual');
  for (const level of ['balanced', 'strict', 'lockdown'] as const) assert.equal(effectiveConsentMode('auto', level), 'reject');
  assert.equal(effectiveConsentMode('hide', 'strict'), 'hide');
  assert.equal(effectiveConsentMode('manual', 'lockdown'), 'manual');
});
