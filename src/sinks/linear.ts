import type { Report, Ticket } from '../types'
import type { Sink } from './types'
import { annotationBody, firstLine, ticketBody } from './format'

export interface LinearSinkOptions {
  /** Personal API key (lin_api_…), sent as the Authorization header the way Linear expects. */
  apiKey: string
  /** Team UUID, or the team key people actually know ("ENG") — keys are resolved once and cached. */
  team: string
  /** GraphQL endpoint. Defaults to Linear cloud. */
  baseUrl?: string
  /** Sink name used in errors. Defaults to "linear". */
  name?: string
  fetch?: typeof globalThis.fetch
}

interface LinearIssueNode {
  id: string
  identifier: string
  title: string
  description?: string | null
  url?: string
  state?: { type?: string }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Fingerprints survive the round trip through Linear as a trailing
 * "rocky:fingerprint:<encoded>" line in the description (Linear normalizes
 * HTML comments away, so the marker has to be plain text). Stripped from the
 * summary that the matcher and the LLM see.
 */
const FINGERPRINT_LINE = /\n?^rocky:fingerprint:(\S+)$/m

/**
 * Linear as the ticket store, via its GraphQL API.
 *
 * State mapping from Linear workflow-state types onto Rocky's enum:
 * triage/backlog → "open", unstarted (accepted into the workflow) →
 * "approved", started → "in_progress", completed/canceled → "closed".
 */
export function linearSink(options: LinearSinkOptions): Sink {
  const {
    apiKey,
    team,
    baseUrl = 'https://api.linear.app/graphql',
    name = 'linear',
    fetch = globalThis.fetch,
  } = options

  const gql = async <T>(query: string, variables: Record<string, unknown>): Promise<T> => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    })
    if (!response.ok) {
      throw new Error(`${name}: HTTP ${response.status} from Linear — ${(await response.text()).slice(0, 200)}`)
    }
    const payload = (await response.json()) as { data?: T; errors?: Array<{ message?: string }> }
    if (payload.errors && payload.errors.length > 0) {
      throw new Error(`${name}: GraphQL error — ${payload.errors.map((e) => e.message ?? 'unknown').join('; ')}`)
    }
    if (!payload.data) throw new Error(`${name}: empty GraphQL response`)
    return payload.data
  }

  let teamIdPromise: Promise<string> | null = null
  const teamId = (): Promise<string> => {
    teamIdPromise ??= (async () => {
      if (UUID.test(team)) return team
      const data = await gql<{ teams: { nodes: Array<{ id: string }> } }>(
        `query TeamByKey($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }`,
        { key: team },
      )
      const id = data.teams.nodes[0]?.id
      if (!id) throw new Error(`${name}: no team with key "${team}"`)
      return id
    })()
    return teamIdPromise
  }

  const labelIds = new Map<string, string>()
  const resolveLabels = async (labels: string[]): Promise<string[]> => {
    const missing = labels.filter((label) => !labelIds.has(label))
    if (missing.length > 0) {
      const data = await gql<{ issueLabels: { nodes: Array<{ id: string; name: string }> } }>(
        `query LabelsByName($names: [String!]) { issueLabels(filter: { name: { in: $names } }) { nodes { id name } } }`,
        { names: missing },
      )
      for (const node of data.issueLabels.nodes) labelIds.set(node.name, node.id)
      for (const label of labels) {
        if (labelIds.has(label)) continue
        const created = await gql<{ issueLabelCreate: { issueLabel?: { id: string } } }>(
          `mutation CreateLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
          { input: { name: label, teamId: await teamId() } },
        )
        const id = created.issueLabelCreate.issueLabel?.id
        if (!id) throw new Error(`${name}: could not create label "${label}"`)
        labelIds.set(label, id)
      }
    }
    return labels.map((label) => labelIds.get(label)!)
  }

  return {
    name,
    async listOpen() {
      const tickets: Ticket[] = []
      let after: string | null = null
      for (let page = 0; page < 10; page++) {
        const data: {
          issues: { nodes: LinearIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
        } = await gql(
          `query OpenIssues($teamId: ID, $after: String) {
            issues(
              first: 100
              after: $after
              filter: { team: { id: { eq: $teamId } }, state: { type: { nin: ["completed", "canceled"] } } }
            ) {
              nodes { id identifier title description url state { type } }
              pageInfo { hasNextPage endCursor }
            }
          }`,
          { teamId: await teamId(), after },
        )
        tickets.push(...data.issues.nodes.map((node) => toTicket(node)))
        if (!data.issues.pageInfo.hasNextPage) break
        after = data.issues.pageInfo.endCursor
      }
      return tickets
    },

    async create(report, opts) {
      const marker = report.fingerprint ? `\n\nrocky:fingerprint:${encodeURIComponent(report.fingerprint)}` : ''
      const input: Record<string, unknown> = {
        teamId: await teamId(),
        title: report.title ?? firstLine(report.text),
        description: ticketBody(report) + marker,
      }
      if (opts.labels.length > 0) input['labelIds'] = await resolveLabels(opts.labels)

      const data = await gql<{ issueCreate: { success?: boolean; issue?: LinearIssueNode } }>(
        `mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) { success issue { id identifier title description url state { type } } }
        }`,
        { input },
      )
      const issue = data.issueCreate.issue
      if (!data.issueCreate.success || !issue) {
        throw new Error(`${name}: issue creation did not succeed`)
      }
      return toTicket(issue)
    },

    async annotate(ticketId, report) {
      // Accept either the human identifier ("ENG-123") or a UUID: resolve to
      // the UUID commentCreate requires.
      const resolved = await gql<{ issue: { id: string } | null }>(
        `query IssueById($id: String!) { issue(id: $id) { id } }`,
        { id: String(ticketId) },
      )
      if (!resolved.issue) throw new Error(`${name}: no issue "${String(ticketId)}" to annotate`)
      const data = await gql<{ commentCreate: { success?: boolean } }>(
        `mutation CreateComment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
        { input: { issueId: resolved.issue.id, body: annotationBody(report) } },
      )
      if (!data.commentCreate.success) {
        throw new Error(`${name}: comment creation did not succeed on "${String(ticketId)}"`)
      }
    },
  }
}

function toTicket(node: LinearIssueNode): Ticket {
  const description = node.description ?? ''
  const match = FINGERPRINT_LINE.exec(description)
  const fingerprint = match?.[1] ? safeDecode(match[1]) : null
  const summary = description.replace(FINGERPRINT_LINE, '').trim()
  return {
    id: node.identifier,
    title: node.title,
    summary: summary.length > 2000 ? `${summary.slice(0, 2000)}…` : summary,
    fingerprint,
    state: toState(node.state?.type),
    link: node.url ?? '',
  }
}

function toState(type: string | undefined): Ticket['state'] {
  switch (type) {
    case 'completed':
    case 'canceled':
      return 'closed'
    case 'started':
      return 'in_progress'
    case 'unstarted':
      return 'approved'
    default:
      return 'open'
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
