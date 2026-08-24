/**
 * Unresolved contacts — candidates the system could not confidently resolve.
 *
 * Deliberately not a raw debugging view: each card states plainly why the
 * candidate is here, what evidence exists, and which existing leads it might
 * be, then offers three unambiguous outcomes.
 */

import { h, icon, replace, fmtTime, fmtAgo } from '../ui/dom.js';
import { panel, confidence, badge, emptyState, openDrawer, toast, banner } from '../ui/primitives.js';
import { getUnresolved } from '../api.js';
import { navigate } from '../router.js';

const KIND_ICON = { voice: 'mic', image: 'camera', text: 'message' };

export async function renderUnresolved(root) {
  const { data: candidates } = await getUnresolved();
  const remaining = [...candidates];

  const list = h('div.grid.grid-2', { style: { alignItems: 'start' } });

  function paint() {
    if (!remaining.length) {
      replace(list, h('div', { style: { gridColumn: '1 / -1' } },
        panel({
          body: emptyState({
            tone: 'ok',
            title: 'No unresolved contacts',
            note: 'All incoming contacts have been confidently resolved into leads.',
          }),
        })));
      return;
    }
    replace(list, remaining.map(card));
  }

  function resolveCandidate(candidate, message) {
    const i = remaining.indexOf(candidate);
    if (i >= 0) remaining.splice(i, 1);
    paint();
    toast(message, 'ok');
  }

  /** Review drawer: full evidence plus the three possible outcomes. */
  function openReview(c) {
    openDrawer({
      title: c.label,
      subtitle: `${c.name} · ${c.company}`,
      body: h('div.stack-4',
        h('div',
          h('div.eyebrow', { style: { marginBottom: '6px' } }, 'Why this needs review'),
          h('p.t-sm', c.reason)),

        h('div',
          h('div.eyebrow', { style: { marginBottom: '6px' } }, 'Confidence'),
          confidence(c.confidence, { size: 'lg' })),

        h('div',
          h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } },
            `Evidence · ${c.messages} message${c.messages === 1 ? '' : 's'}`),
          h('div.stack-4', c.evidence.map((e) => h('div.evidence',
            h('div.evidence-head', icon(KIND_ICON[e.type] || 'message', 12),
              e.type === 'image' ? 'Business card' : e.type === 'voice' ? 'Voice message' : 'Text',
              h('span.right', fmtTime(e.ts))),
            h('div.evidence-quote', e.quote))))),

        c.matches.length
          ? h('div',
              h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, 'Possible matches'),
              h('div.col', c.matches.map((m) => h('div.panel', { style: { padding: 'var(--sp-3)' } },
                h('div.between',
                  h('div',
                    h('div.fw-medium.t-sm', m.label),
                    h('div.t-xs.subtle', m.person)),
                  h('div.row', { style: { minWidth: '120px' } }, confidence(m.score))),
                h('div.row', { style: { marginTop: 'var(--sp-3)', gap: 'var(--sp-2)' } },
                  h('button.btn.btn-sm.btn-primary', {
                    onclick: () => { resolveCandidate(c, `Merged into ${m.label}`); closeAll(); },
                  }, icon('merge', 12), 'Merge into this lead'),
                  h('button.btn.btn-sm', { onclick: () => navigate(`leads/${m.id}`) }, 'Open lead'))))))
          : banner('info', h('div', 'No existing lead resembles this candidate — creating a separate lead is likely correct.')),
      ),
      footer: (close) => {
        closeAll = close;
        return [
          h('button.btn.btn-primary', {
            onclick: () => { resolveCandidate(c, 'Kept as a separate lead'); close(); },
          }, icon('split', 13), 'Keep as separate lead'),
          h('button.btn', {
            onclick: () => { resolveCandidate(c, 'Candidate ignored'); close(); },
          }, 'Ignore'),
        ];
      },
    });
  }
  let closeAll = () => {};

  function card(c) {
    return h('section.panel',
      h('div.panel-head',
        h('div',
          h('div.row', { style: { gap: 'var(--sp-2)' } },
            h('h2.panel-title', c.name),
            badge(c.label, 'neutral')),
          h('div.t-xs.subtle', { style: { marginTop: '2px' } }, c.company)),
        h('div', { style: { minWidth: '110px' } }, confidence(c.confidence))),

      h('div.panel-body',
        h('p.t-sm.muted', c.reason),

        c.matches.length
          ? h('div', { style: { marginTop: 'var(--sp-4)' } },
              h('div.eyebrow', { style: { marginBottom: 'var(--sp-2)' } }, 'Possible matches'),
              h('div.col', c.matches.map((m) => h('div.between',
                h('span.t-sm.truncate', m.label),
                h('div', { style: { width: '96px' } }, confidence(m.score))))))
          : h('div.t-sm.faint', { style: { marginTop: 'var(--sp-3)' } }, 'No similar leads found'),

        h('div.row', { style: { marginTop: 'var(--sp-4)', gap: '6px' } },
          icon(KIND_ICON[c.evidence[0]?.type] || 'message', 13, 'subtle'),
          h('span.t-xs.subtle', `Last evidence: ${c.lastEvidence} · ${fmtAgo(c.lastEvidenceAt)}`))),

      h('div.panel-head', { style: { borderBottom: 'none', borderTop: '1px solid var(--c-border)' } },
        h('span.t-xs.subtle', `Owner: ${c.owner.name}`),
        h('div.row',
          h('button.btn.btn-sm', { onclick: () => resolveCandidate(c, 'Candidate ignored') }, 'Ignore'),
          h('button.btn.btn-sm.btn-primary', { onclick: () => openReview(c) }, 'Review'))),
    );
  }

  paint();

  replace(root,
    h('div.page-head',
      h('div',
        h('h1.page-title', 'Unresolved contacts'),
        h('p.page-subtitle', 'Candidates that need a human decision before they become leads')),
      h('div.row', h('span.t-sm.subtle', `${remaining.length} waiting`))),
    list,
  );
}
