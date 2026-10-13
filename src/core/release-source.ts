/** Distribution identity is baked into standalone artifacts. Keep the official
 * default for upstream/source installs; fork builds read their own fork.json. */
export const OFFICIAL_GITHUB_REPO = 'deepcoldy/botmux';

const repository = process.env.BOTMUX_BAKED_RELEASE_REPO
  ?? process.env.BOTMUX_RELEASE_REPO
  ?? OFFICIAL_GITHUB_REPO;

// An invalid override must never silently redirect a fork back to upstream.
if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)) {
  throw new Error('Invalid Botmux release repository; expected owner/repo');
}

export const GITHUB_REPO: string = repository;
export const USE_FORK_RELEASES = GITHUB_REPO !== OFFICIAL_GITHUB_REPO;
