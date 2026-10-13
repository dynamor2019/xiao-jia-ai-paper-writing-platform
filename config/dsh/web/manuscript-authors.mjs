/** Author rows entered in the paper workbench. Empty rows stay in the form; only named rows enter a draft. */

export const MANUSCRIPT_AUTHOR_RANKS = [
  { id: '1', label: '第一作者', order: 1, corresponding: false },
  { id: '1c', label: '第一作者（通讯作者）', order: 1, corresponding: true },
  { id: '2', label: '第二作者', order: 2, corresponding: false },
  { id: '2c', label: '第二作者（通讯作者）', order: 2, corresponding: true },
  { id: '3', label: '第三作者', order: 3, corresponding: false },
  { id: '3c', label: '第三作者（通讯作者）', order: 3, corresponding: true },
  { id: '4', label: '第四作者', order: 4, corresponding: false },
  { id: '4c', label: '第四作者（通讯作者）', order: 4, corresponding: true },
  { id: '5', label: '第五作者', order: 5, corresponding: false },
  { id: '5c', label: '第五作者（通讯作者）', order: 5, corresponding: true },
  { id: '6', label: '第六作者', order: 6, corresponding: false },
  { id: '6c', label: '第六作者（通讯作者）', order: 6, corresponding: true },
  { id: '7', label: '其他作者', order: 7, corresponding: false },
  { id: '7c', label: '其他作者（通讯作者）', order: 7, corresponding: true },
];

const RANK_BY_ID = new Map(MANUSCRIPT_AUTHOR_RANKS.map((rank) => [rank.id, rank]));
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function blankManuscriptAuthor(rank = '1') {
  return { name: '', rank, email: '', affiliation: '' };
}

function clip(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** Keep a stable form, including a blank row. Do not invent names, emails, or affiliations. */
export function sanitizeAuthorForm(input) {
  const rows = Array.isArray(input) ? input.slice(0, 12) : [];
  const clean = rows.map((row) => ({
    name: clip(row?.name, 80),
    rank: RANK_BY_ID.has(String(row?.rank || '')) ? String(row.rank) : '7',
    email: clip(row?.email, 120),
    affiliation: clip(row?.affiliation, 200),
  }));
  return clean.length ? clean : [blankManuscriptAuthor()];
}

/** Plain-text title block for the assembled draft. Rows without a name are omitted. */
export function renderAuthorBlock(input) {
  const rows = sanitizeAuthorForm(input)
    .map((row, index) => ({ ...row, index, rankInfo: RANK_BY_ID.get(row.rank) }))
    .filter((row) => row.name);
  if (!rows.length) return '';
  rows.sort((a, b) => a.rankInfo.order - b.rankInfo.order || a.index - b.index);
  const affiliations = [];
  const letterFor = (affiliation) => {
    const key = affiliation.toLowerCase();
    const existing = affiliations.find((item) => item.key === key);
    if (existing) return existing.letter;
    const letter = String.fromCharCode(97 + affiliations.length);
    affiliations.push({ key, letter, text: affiliation });
    return letter;
  };
  const byline = rows.map((row) => {
    const marks = [];
    if (row.affiliation) marks.push(letterFor(row.affiliation));
    if (row.rankInfo.corresponding) marks.push('*');
    return marks.length ? `${row.name} ${marks.join(',')}` : row.name;
  }).join(', ');
  const affiliationLines = affiliations.map((item) => `${item.letter} ${item.text}`);
  const emails = rows
    .filter((row) => EMAIL_PATTERN.test(row.email))
    .map((row) => `${row.name}: ${row.email}`);
  const corresponding = rows.filter((row) => row.rankInfo.corresponding).map((row) => row.name);
  const lines = [byline];
  if (affiliationLines.length) lines.push('', ...affiliationLines);
  if (emails.length) lines.push('', ...emails);
  if (corresponding.length) lines.push('', `* Corresponding author: ${corresponding.join('; ')}`);
  return lines.join('\n');
}
