export interface ReferenceRecord {
  doi: string;
  citation: string;
  status: 'metadata-match' | 'mismatch' | 'not-found' | 'unavailable';
  title?: string;
  year?: number;
  reason: string;
}

type Metadata = { title?: string[]; published?: { 'date-parts'?: number[][] } };

/** Retrieve bibliographic metadata only; this does not verify support for a cited claim. */
async function lookupMetadata(doi: string): Promise<Metadata | undefined> {
  const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    signal: AbortSignal.timeout(15000), headers: { Accept: 'application/json' },
  });
  if (response.status === 404) {
    const alternate = await fetch(`https://api.datacite.org/dois/${encodeURIComponent(doi)}`, { signal: AbortSignal.timeout(15000) });
    if (alternate.status === 404) return undefined;
    if (!alternate.ok) throw new Error(`DataCite HTTP ${alternate.status}`);
    const record = (await alternate.json() as { data: { attributes: { titles: { title: string }[]; publicationYear: number } } }).data.attributes;
    return { title: record.titles.map(item => item.title), published: { 'date-parts': [[record.publicationYear]] } };
  }
  if (!response.ok) throw new Error(`Crossref HTTP ${response.status}`);
  return (await response.json() as { message: Metadata }).message;
}

/** Normalize punctuation and spacing for literal bibliography/title comparison. */
function normalized(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Match a DOI to its actual title and publication year without approving scientific claims. */
export async function auditReferenceMetadata(markdown: string, lookup = lookupMetadata, cache: ReferenceRecord[] = []): Promise<ReferenceRecord[]> {
  const references = markdown.split(/^##\s+References\s*$/mi)[1];
  if (!references) return [];
  const citations = references.split(/\r?\n/).filter(line => /https?:\/\/(?:dx\.)?doi\.org\//i.test(line));
  const records: ReferenceRecord[] = [];
  for (let offset = 0; offset < citations.length; offset += 3) {
    const batch = await Promise.all(citations.slice(offset, offset + 3).map(async (citation): Promise<ReferenceRecord> => {
      const doi = citation.match(/https?:\/\/(?:dx\.)?doi\.org\/([^\s]+)/i)![1].replace(/[.,;]+$/, '');
      const previous = cache.find(record => record.doi === doi && record.citation === citation && record.status === 'metadata-match');
      if (previous) return previous;
      try {
        const metadata = await lookup(doi);
        if (!metadata) return { doi, citation, status: 'not-found', reason: 'DOI not registered in Crossref; independent verification required, not proof of nonexistence.' };
        const title = metadata.title?.[0];
        const year = metadata.published?.['date-parts']?.[0]?.[0];
        const statedYear = Number(citation.match(/\((\d{4})\)/)?.[1]);
        const titleMatches = Boolean(title && normalized(citation).includes(normalized(title)));
        const yearMatches = Boolean(year && statedYear && Math.abs(year - statedYear) <= 1);
        return { doi, citation, title, year, status: titleMatches && yearMatches ? 'metadata-match' : 'mismatch',
          reason: titleMatches && yearMatches ? 'Registered title and year match; author identities and claim support remain separate checks.'
            : 'Registered title or year does not match the bibliography; inspect the source before using this citation.' };
      } catch (error) {
        return { doi, citation, status: 'unavailable', reason: error instanceof Error ? error.message : String(error) };
      }
    }));
    records.push(...batch);
  }
  return records;
}
