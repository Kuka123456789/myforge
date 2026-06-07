import type { Env } from '../index';

const API = 'https://api.github.com';

async function ghFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${env.GITHUB_TOKEN}`);
  headers.set('accept', 'application/vnd.github+json');
  headers.set('x-github-api-version', '2022-11-28');
  headers.set('user-agent', 'myforge');
  return fetch(`${API}${path}`, { ...init, headers });
}

interface CodeSearchInput {
  query: string;
  repo?: string; // owner/name, defaults to env.GITHUB_DEFAULT_REPO
  max_results?: number;
}

export async function githubCodeSearch(env: Env, input: CodeSearchInput): Promise<unknown> {
  const repo = input.repo ?? env.GITHUB_DEFAULT_REPO;
  const max = Math.min(input.max_results ?? 8, 20);
  // GitHub code search query: "<term> repo:owner/name"
  const q = `${input.query} repo:${repo}`;
  const res = await ghFetch(env, `/search/code?q=${encodeURIComponent(q)}&per_page=${max}`);
  if (!res.ok) throw new Error(`GitHub code search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    items?: Array<{ name: string; path: string; html_url: string; repository: { full_name: string } }>;
    total_count?: number;
  };
  return {
    repo,
    query: input.query,
    total: data.total_count ?? 0,
    results: (data.items ?? []).map((item) => ({
      path: item.path,
      url: item.html_url,
      repo: item.repository.full_name,
    })),
  };
}

interface FileGetInput {
  path: string;
  repo?: string;
  ref?: string; // branch / sha; defaults to repo default branch
}

export async function githubFileGet(env: Env, input: FileGetInput): Promise<unknown> {
  const repo = input.repo ?? env.GITHUB_DEFAULT_REPO;
  const refQuery = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : '';
  const res = await ghFetch(
    env,
    `/repos/${repo}/contents/${encodeURIComponent(input.path).replace(/%2F/g, '/')}${refQuery}`,
  );
  if (!res.ok) throw new Error(`GitHub file get failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    name: string;
    path: string;
    content?: string;
    encoding?: string;
    html_url: string;
    size: number;
  };

  if (!data.content) {
    return { path: data.path, url: data.html_url, error: 'No content returned (binary or too large)' };
  }

  const decoded = data.encoding === 'base64' ? atob(data.content.replace(/\n/g, '')) : data.content;

  return {
    path: data.path,
    url: data.html_url,
    size: data.size,
    content: decoded.slice(0, 12000),
    truncated: decoded.length > 12000,
  };
}

interface RepoStatsInput {
  repo?: string;
}

export async function githubRepoStats(env: Env, input: RepoStatsInput): Promise<unknown> {
  const repo = input.repo ?? env.GITHUB_DEFAULT_REPO;
  const [repoRes, langRes] = await Promise.all([
    ghFetch(env, `/repos/${repo}`),
    ghFetch(env, `/repos/${repo}/languages`),
  ]);
  if (!repoRes.ok) throw new Error(`GitHub repo fetch failed: ${repoRes.status}`);
  if (!langRes.ok) throw new Error(`GitHub languages fetch failed: ${langRes.status}`);

  const meta = (await repoRes.json()) as {
    full_name: string;
    default_branch: string;
    size: number;
    stargazers_count: number;
    open_issues_count: number;
    pushed_at: string;
    language: string;
  };
  const languages = (await langRes.json()) as Record<string, number>;

  const totalBytes = Object.values(languages).reduce((a, b) => a + b, 0);
  const breakdown = Object.entries(languages)
    .sort(([, a], [, b]) => b - a)
    .map(([lang, bytes]) => ({
      language: lang,
      bytes,
      percent: totalBytes ? +((bytes / totalBytes) * 100).toFixed(1) : 0,
    }));

  // Rough lines-of-code estimate using bytes ÷ avg_chars_per_line per language.
  const AVG_LINE_LEN: Record<string, number> = {
    TypeScript: 35, JavaScript: 35, TSX: 35, JSX: 35, Python: 30,
    Java: 35, Go: 30, Rust: 35, HTML: 50, CSS: 30, SCSS: 30,
    JSON: 60, Markdown: 80, YAML: 40, Shell: 40,
  };
  const estimatedLines = Object.entries(languages).reduce(
    (sum, [lang, bytes]) => sum + Math.round(bytes / (AVG_LINE_LEN[lang] ?? 35)),
    0,
  );

  return {
    repo: meta.full_name,
    default_branch: meta.default_branch,
    size_kb: meta.size,
    primary_language: meta.language,
    stars: meta.stargazers_count,
    open_issues: meta.open_issues_count,
    last_push: meta.pushed_at,
    total_bytes: totalBytes,
    estimated_total_lines: estimatedLines,
    note: 'estimated_total_lines is bytes-divided-by-avg-line-length, ±20% accuracy. For exact count use code_execution.',
    languages: breakdown,
  };
}

interface IssueSearchInput {
  query: string;
  repo?: string;
  max_results?: number;
}

export async function githubIssueSearch(env: Env, input: IssueSearchInput): Promise<unknown> {
  const repo = input.repo ?? env.GITHUB_DEFAULT_REPO;
  const max = Math.min(input.max_results ?? 5, 15);
  const q = `${input.query} repo:${repo}`;
  const res = await ghFetch(env, `/search/issues?q=${encodeURIComponent(q)}&per_page=${max}`);
  if (!res.ok) throw new Error(`GitHub issue search failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as {
    items?: Array<{
      number: number;
      title: string;
      state: string;
      html_url: string;
      pull_request?: object;
    }>;
    total_count?: number;
  };
  return {
    repo,
    total: data.total_count ?? 0,
    results: (data.items ?? []).map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      type: item.pull_request ? 'pr' : 'issue',
      url: item.html_url,
    })),
  };
}
