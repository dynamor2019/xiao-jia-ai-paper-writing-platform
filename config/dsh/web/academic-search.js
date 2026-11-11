const name = 'web-search-openalex';
const inject = ['web'];

const OPENALEX_API = 'https://api.openalex.org/works';
const CROSSREF_API = 'https://api.crossref.org/works';
const PROVIDER_ID = 'openalex';
const CACHE_TTL_MS = 5 * 60 * 1000;
const MIN_OPENALEX_INTERVAL_MS = 150;
const MAX_OPENALEX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 5000;

const searchCache = new Map();
let openAlexQueue = Promise.resolve();
let lastOpenAlexRequestAt = 0;

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
  // 优先返回开放获取全文地址，便于后续取全文做引用核验与 PDF 解析
  return work.open_access?.oa_url || work.doi || work.primary_location?.landing_page_url || work.id;
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

function retryAfterMs(value) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : undefined;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('Search aborted.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new Error('Search aborted.'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function fetchOpenAlex(url, signal) {
  const request = openAlexQueue.then(async () => {
    for (let attempt = 0; attempt <= MAX_OPENALEX_RETRIES; attempt += 1) {
      if (signal?.aborted) throw signal.reason || new Error('Search aborted.');
      const spacing = Math.max(0, MIN_OPENALEX_INTERVAL_MS - (Date.now() - lastOpenAlexRequestAt));
      if (spacing) await delay(spacing, signal);
      lastOpenAlexRequestAt = Date.now();

      const response = await fetch(url, {
        signal,
        headers: {
          accept: 'application/json',
          'user-agent': 'paper-agent-dsh/0.1 (academic literature search)',
        },
      });
      if (response.status !== 429) {
        if (!response.ok) throw new Error(`OpenAlex search failed with HTTP ${response.status}.`);
        const contentType = response.headers.get('content-type') || '';
        if (!contentType.includes('application/json')) {
          throw new Error(`OpenAlex returned a non-JSON response (${contentType || 'unknown type'}).`);
        }
        return response.json();
      }

      const body = await response.text();
      const headerWait = retryAfterMs(response.headers.get('retry-after'));
      const waitMs = headerWait ?? 1000 * (attempt + 1);
      if (attempt === MAX_OPENALEX_RETRIES || waitMs > MAX_RETRY_WAIT_MS) {
        const detail = body.trim().slice(0, 240);
        const error = new Error(`OpenAlex rate limited the request (HTTP 429)${detail ? `: ${detail}` : '.'}`);
        error.name = 'OpenAlexRateLimitError';
        throw error;
      }
      await delay(waitMs, signal);
    }
    throw new Error('OpenAlex retry limit reached.');
  });
  openAlexQueue = request.catch(() => undefined);
  return request;
}

function mapCrossrefWork(work) {
  const authors = (work.author || [])
    .slice(0, 4)
    .map((author) => [author.given, author.family].filter(Boolean).join(' '))
    .filter(Boolean)
    .join(', ');
  const year = work.published?.['date-parts']?.[0]?.[0]
    || work['published-print']?.['date-parts']?.[0]?.[0]
    || work['published-online']?.['date-parts']?.[0]?.[0];
  const venue = work['container-title']?.[0];
  const metadata = [authors, venue, year].filter(Boolean).join(' | ');
  const abstract = (work.abstract || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const doiUrl = work.DOI ? `https://doi.org/${work.DOI}` : undefined;
  return {
    url: work.URL || doiUrl,
    title: work.title?.[0] || 'Untitled academic work',
    snippet: [metadata, abstract].filter(Boolean).join('\n'),
    ...(year ? { publishedAt: String(year) } : {}),
  };
}

async function searchCrossref(query, maxResults, signal) {
  const url = new URL(CROSSREF_API);
  url.searchParams.set('query', query);
  url.searchParams.set('rows', String(maxResults));
  const response = await fetch(url, {
    signal,
    headers: {
      accept: 'application/json',
      'user-agent': 'paper-agent-dsh/0.1 (academic literature search)',
    },
  });
  if (!response.ok) throw new Error(`Crossref fallback failed with HTTP ${response.status}.`);
  const payload = await response.json();
  const items = payload.message?.items;
  return Array.isArray(items) ? items.map(mapCrossrefWork).filter((work) => work.url) : [];
}

async function searchSources(query, maxResults, url, signal) {
  try {
    const body = await fetchOpenAlex(url, signal);
    return Array.isArray(body.results)
      ? body.results.filter((work) => sourceUrl(work)).map(mapWork)
      : [];
  } catch (error) {
    if (error?.name !== 'OpenAlexRateLimitError') throw error;
    console.warn(`${error.message} Falling back to Crossref.`);
    try {
      return await searchCrossref(query, maxResults, signal);
    } catch (fallbackError) {
      throw new Error(`${error.message} Crossref fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
    }
  }
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
    const cacheKey = `${query.toLowerCase()}\n${maxResults}`;
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) {
      return { sources: cached.sources.map((source) => ({ ...source })), truncated: false };
    }
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
      'open_access',
    ].join(','));

    const sources = await searchSources(query, maxResults, url, signal);
    searchCache.set(cacheKey, { savedAt: Date.now(), sources });
    if (searchCache.size > 100) searchCache.delete(searchCache.keys().next().value);

    return { sources, truncated: false };
  },
};

function apply(ctx) {
  ctx.web.registerSearchProvider(provider);
}

export { apply, inject, name };
