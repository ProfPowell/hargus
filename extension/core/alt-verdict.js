// WAVE-style verdicts for an image's alternative text. Pure. Trigger wording follows WAVE's item list
// (docs/research/wave-items.tsv: alt_missing, alt_suspicious, alt_redundant, alt_long, alt_duplicate).

export const VERDICTS = ['missing', 'empty-linked', 'empty-decorative', 'suspicious', 'redundant', 'long', 'filename', 'repeated', 'ok'];

export const VERDICT_LABELS = {
  missing: 'missing',
  'empty-linked': 'empty in link',
  'empty-decorative': 'decorative',
  suspicious: 'suspicious',
  redundant: 'redundant',
  long: 'too long',
  filename: 'file name',
  repeated: 'repeated',
  ok: 'ok',
};

// WAVE: alt "is one of" these, "begins with" graphic of / bullet / image of, "ends with" image / graphic, or is only spaces.
const WORDS = new Set(['image', 'graphic', 'photo', 'photograph', 'drawing', 'painting', 'artwork', 'logo', 'bullet', 'button', 'arrow', 'more', 'spacer', 'blank', 'chart', 'table', 'diagram', 'graph', '*']);
const BEGINS = /^(graphic|image|photo|picture) of\b|^bullet\b/;
const ENDS = /\b(image|graphic)$/;
const FILE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const FILE_STEM = /^(img|dsc|dscn|dcim|pict|image|photo|pic|screenshot)[-_ ]?\d{2,}$|^(?=[\w-]*[a-z])[\w-]*\d{4,}[\w-]*$/i;

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function suspicious(alt) {
  if (alt !== '' && !alt.trim()) return true; // alt=" "
  const t = norm(alt);
  return WORDS.has(t) || BEGINS.test(t) || ENDS.test(t);
}

function redundant(alt, adjacent) {
  const a = norm(alt);
  const t = norm(adjacent);
  if (!a || !t) return false;
  if (a === t) return true;
  const [short, long] = a.length <= t.length ? [a, t] : [t, a];
  return long.includes(short) && long.length - short.length <= 15;
}

/** { verdict, note } for one image. `repeats` is how many distinct images share this alt text (1 = unique). */
export function altVerdict(img, { repeats = 1 } = {}) {
  const alt = img.alt == null ? null : String(img.alt);
  const name = String(img.name ?? '').trim();
  if (alt === null && !name) return { verdict: 'missing', note: 'No alt attribute and no other accessible name.' };
  if (alt === '' && !name) {
    if (img.inLink && !norm(img.adjacentText)) return { verdict: 'empty-linked', note: 'Empty alt on an image that is the only content of a link: the link has no name.' };
    return { verdict: 'empty-decorative', note: 'Empty alt: treated as decorative and skipped by screen readers.' };
  }
  const text = alt !== null && alt !== '' ? alt : name;
  if (suspicious(text)) return { verdict: 'suspicious', note: 'Alt text is a generic word, a "image of" phrase or blank; describe what the image shows or means.' };
  if (redundant(text, img.adjacentText)) return { verdict: 'redundant', note: 'Alt text repeats the text next to the image, so it is read twice.' };
  if (text.length > 100) return { verdict: 'long', note: `Alt text is ${text.length} characters; over 100 is usually better as nearby text or a long description.` };
  if (FILE_EXT.test(text.trim()) || FILE_STEM.test(text.trim())) return { verdict: 'filename', note: 'Alt text looks like a file name rather than a description.' };
  if (repeats >= 2) return { verdict: 'repeated', note: `The same alt text is used on ${repeats} different images.` };
  return { verdict: 'ok', note: 'Has alt text; whether it is accurate needs a person.' };
}

/** Images with `verdict` and `note` added; `repeats` counts distinct sources per (case-insensitive) alt. */
export function altVerdicts(images = []) {
  const srcs = new Map();
  for (const i of images) {
    const k = norm(i.alt);
    if (!k) continue;
    if (!srcs.has(k)) srcs.set(k, new Set());
    srcs.get(k).add(i.src);
  }
  return images.map((i) => ({ ...i, ...altVerdict(i, { repeats: srcs.get(norm(i.alt))?.size || 1 }) }));
}
