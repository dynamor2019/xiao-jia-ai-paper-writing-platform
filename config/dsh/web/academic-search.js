const name = 'web-search-openalex';
const inject = ['web'];

const OPENALEX_API = 'https://api.openalex.org/works';
const PROVIDER_ID = 'openalex';

function abstractFromIndex(index) {
  if (!index || typeof index !== 'object') return undefined;

  const words = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) words[position] = word;
  }

  const abstract = words.filter(Boolean).join(' ').trim();
  if (!abstract) return undefined;
  return abstract.length > 600 ? `${abstract.slice(0, 597)}...` : abstract;
}

function sourceUrl(work) {
  return work.doi || work.primary_location?.landing_page_url || work.id;
}

function mapWork(work) {
  const authors = (work.authorships || [])
    .slice(0, 4)
    .map((item) => item.author?.display_name)
    .filter(Boolean)
    .join(', ');
  const abstract = abstractFromIndex(work.abstract_inverted_index);
  const venue = work.primary_location?.source?.display_name;
  const metadata = [authors, venue, work.publication_year].filter(Boolean).join(' | ');

  return {
    url: sourceUrl(work),
    title: work.display_name || work.title || 'Untitled academic work',
    snippet: [metadata, abstract].filter(Boolean).join('\n'),
    ...(work.publication_date ? { publishedAt: work.publication_date } : {}),
  };
}

const provider = {
  id: PROVIDER_ID,
  available() {
    return typeof fetch === 'function';
  },
  async search(request, signal) {
    const query = request.query?.trim();
    if (!query) throw new Error('Academic search query cannot be empty.');

    const maxResults = Math.min(Math.max(request.maxResults || 8, 1), 25);
    const url = new URL(OPENALEX_API);
    url.searchParams.set('search', query);
    url.searchParams.set('per-page', String(maxResults));
    url.searchParams.set('select', [
      'id',
      'doi',
      'display_name',
      'publication_date',
      'publication_year',
      'authorships',
      'primary_location',
      'abstract_inverted_index',
    ].join(','));

    const response = await fetch(url, {
      signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'paper-agent-dsh/0.1 (academic literature search)',
      },
    });

    if (!response.ok) {
      throw new Error(`OpenAlex search failed with HTTP ${response.status}.`);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      throw new Error(`OpenAlex returned a non-JSON response (${contentType || 'unknown type'}).`);
    }

    const body = await response.json();
    const sources = Array.isArray(body.results)
      ? body.results.filter((work) => sourceUrl(work)).map(mapWork)
      : [];

    return { sources, truncated: false };
  },
};

function apply(ctx) {
  ctx.web.registerSearchProvider(provider);
}

export { apply, inject, name };
