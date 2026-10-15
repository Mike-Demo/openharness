import { likeCounts } from './communityLikes.js'
import { prisma } from './prisma.js'

export const feedSorts = ['newest', 'popular'] as const
export type FeedSort = typeof feedSorts[number]

/** What a feed card reads: never the files or the cover's bytes. */
const feedSelect = { id: true, title: true, description: true, category: true, engine: true, harnessId: true, authorId: true, authorName: true, forkedFrom: true, createdAt: true, updatedAt: true } as const
const feedPageSize = 30

type FeedWhere = NonNullable<NonNullable<Parameters<typeof prisma.communityHarness.findMany>[0]>['where']>
const newest = [{ createdAt: 'desc' as const }, { id: 'desc' as const }]

/** One page newest first, the indexed order, after the last id read. One row more tells whether there is another page. */
function newestPage(where: FeedWhere, cursor?: string) {
  return prisma.communityHarness.findMany({
    where, select: feedSelect, orderBy: newest, take: feedPageSize + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  })
}

type Ranked = { id: string; likes: number }

/**
 * Where a popular page starts after [cursor]: the publications after it, and which starters are left.
 * Among equal likes publications come first, newest first, then the starters in the Hub's order. A
 * cursor that has since gone ends the feed rather than starting it over.
 */
async function after(where: FeedWhere, starters: Ranked[], cursor?: string): Promise<{ next: FeedWhere; starters: Ranked[] } | null> {
  if (!cursor) return { next: {}, starters }
  const at = starters.findIndex(starter => starter.id === cursor)
  if (at >= 0) return { next: { likeCount: { lt: starters[at].likes } }, starters: starters.slice(at + 1) }
  const last = await prisma.communityHarness.findFirst({ where: { AND: [where, { id: cursor }] }, select: { likeCount: true, createdAt: true } })
  if (!last) return null
  const { likeCount, createdAt } = last
  return {
    next: { OR: [{ likeCount: { lt: likeCount } }, { likeCount, createdAt: { lt: createdAt } }, { likeCount, createdAt, id: { lt: cursor } }] },
    starters: starters.filter(starter => starter.likes <= likeCount),
  }
}

/**
 * One page most liked first, by the publications' indexed `likeCount`. [starters] — the website's
 * examples, which are not stored here — are ranked alongside, after publications with as many likes,
 * so the page's order names them too.
 */
async function popularPage(where: FeedWhere, autonomousEnv: string, starters: readonly string[], cursor?: string) {
  const counts = await likeCounts(starters, autonomousEnv)
  // Array sort is stable, so equals keep the Hub's order.
  const ranked = starters.map(id => ({ id, likes: counts.get(id) ?? 0 })).sort((a, b) => b.likes - a.likes)
  const start = await after(where, ranked, cursor)
  if (!start) return { rows: [], order: [] }
  const found = await prisma.communityHarness.findMany({
    where: { AND: [where, start.next] }, select: { ...feedSelect, likeCount: true },
    orderBy: [{ likeCount: 'desc' }, ...newest], take: feedPageSize + 1,
  })
  const order: string[] = []
  for (let row = 0, starter = 0; order.length <= feedPageSize && (row < found.length || starter < start.starters.length);) {
    const next = found[row], waiting = start.starters[starter]
    if (next && (!waiting || next.likeCount >= waiting.likes)) { order.push(next.id); row++ } else { order.push(waiting.id); starter++ }
  }
  return { rows: found.map(({ likeCount: _likeCount, ...row }) => row), order }
}

/**
 * A feed page in the reader's order, and the cursor for the next one (null on the last). A popular
 * page also returns `order`: its publications' and [starters]' ids as the reader should see them.
 */
export async function feedPage(where: FeedWhere, autonomousEnv: string, sort: FeedSort, starters: readonly string[], cursor?: string) {
  if (sort === 'newest') {
    const rows = await newestPage(where, cursor)
    const page = rows.slice(0, feedPageSize)
    return { page, nextCursor: rows.length > feedPageSize ? page[page.length - 1].id : null }
  }
  const { rows, order } = await popularPage(where, autonomousEnv, starters, cursor)
  const shown = order.slice(0, feedPageSize)
  const byId = new Map(rows.map(row => [row.id, row]))
  return {
    page: shown.flatMap(id => byId.get(id) ?? []),
    order: shown,
    nextCursor: order.length > feedPageSize ? shown[shown.length - 1] : null,
  }
}

/** Likes, comments and public forks of each harness, and which of them the reader likes. */
export async function feedStats(ids: string[], autonomousEnv: string, userId?: string) {
  const [likeCount, comments, forks, liked] = await Promise.all([
    likeCounts(ids, autonomousEnv),
    prisma.communityComment.groupBy({ by: ['harnessId'], where: { autonomousEnv, harnessId: { in: ids } }, _count: { _all: true } }),
    prisma.communityHarness.groupBy({ by: ['forkedFrom'], where: { autonomousEnv, deletedAt: null, forkedFrom: { in: ids } }, _count: { _all: true } }),
    userId ? prisma.communityLike.findMany({ where: { autonomousEnv, userId, harnessId: { in: ids } }, select: { harnessId: true } }) : [],
  ])
  const commentCount = new Map(comments.map(row => [row.harnessId, row._count._all]))
  const forkCount = new Map(forks.map(row => [row.forkedFrom, row._count._all]))
  const likedIds = new Set(liked.map(row => row.harnessId))
  return Object.fromEntries(ids.map(id => [id, { likes: likeCount.get(id) ?? 0, comments: commentCount.get(id) ?? 0, forks: forkCount.get(id) ?? 0, liked: likedIds.has(id) }]))
}
