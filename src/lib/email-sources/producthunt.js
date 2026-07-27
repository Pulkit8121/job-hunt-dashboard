// Founder / maker discovery via the Product Hunt GraphQL API.
//
// Aimed at early-stage startups, where the person who reads the inbox is often
// the founder — a very different (and usually more responsive) audience than a
// corporate recruiting queue.
//
// Product Hunt itself exposes makers and their product/company website, but NOT
// their email. So this source's job is to produce {name, company, website}
// triples; the address then comes from either the site crawl we already have,
// or the GitHub miner + pattern generator.
//
// Auth: needs a free, non-expiring developer token in PRODUCTHUNT_TOKEN
// (Product Hunt dashboard → API → create an application). Without it this
// source is skipped rather than failing the run.
const ENDPOINT = 'https://api.producthunt.com/v2/api/graphql';
const TIMEOUT = 20000;

const QUERY = `
query RecentPosts($after: String) {
  posts(order: RANKING, first: 20, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        name
        tagline
        website
        makers { name username websiteUrl twitterUsername }
      }
    }
  }
}`;

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

// Product Hunt's `website` field is a tracking redirect (ph.co/...). Resolve it
// to the real destination so we get a usable company domain.
async function resolveWebsite(url) {
  if (!url) return null;
  const direct = domainOf(url);
  if (direct && !/producthunt\.com|ph\.co/.test(direct)) return direct;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
    return domainOf(res.url);
  } catch {
    return null;
  }
}

// Returns [{ founderName, companyName, domain, tagline, source }]
export async function fetchProductHuntMakers({ pages = 3, onProgress = () => {} } = {}) {
  const token = process.env.PRODUCTHUNT_TOKEN;
  if (!token) {
    onProgress('○ Product Hunt skipped — set PRODUCTHUNT_TOKEN to enable (free, non-expiring).');
    return [];
  }

  const out = [];
  const seen = new Set();
  let after = null;

  for (let page = 0; page < pages; page++) {
    let body;
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ query: QUERY, variables: { after } }),
        signal: AbortSignal.timeout(TIMEOUT),
      });
      if (!res.ok) {
        onProgress(`⚠ Product Hunt page ${page + 1}: HTTP ${res.status}`);
        break;
      }
      body = await res.json();
    } catch (e) {
      onProgress(`⚠ Product Hunt page ${page + 1}: ${e.message.slice(0, 60)}`);
      break;
    }

    if (body?.errors?.length) {
      onProgress(`⚠ Product Hunt: ${body.errors[0]?.message?.slice(0, 80)}`);
      break;
    }

    const posts = body?.data?.posts;
    const edges = posts?.edges || [];
    if (!edges.length) break;

    for (const { node } of edges) {
      const domain = await resolveWebsite(node?.website);
      if (!domain) continue;
      for (const maker of node?.makers || []) {
        const key = `${maker.name}|${domain}`;
        if (!maker.name || seen.has(key)) continue;
        seen.add(key);
        out.push({
          founderName: maker.name,
          companyName: node.name || domain,
          domain,
          tagline: (node.tagline || '').slice(0, 120),
          source: 'producthunt',
        });
      }
    }

    onProgress(`… Product Hunt page ${page + 1}: ${edges.length} products, ${out.length} makers so far`);
    if (!posts?.pageInfo?.hasNextPage) break;
    after = posts.pageInfo.endCursor;
  }

  return out;
}
