// These schemas describe the public projection, not the raw registry/index. Keep
// research objects extensible: the checked-in exports can add audited metadata,
// and Fastify's response serializer otherwise silently drops undeclared fields.
const string = { type: 'string' };
const nullableString = { type: ['string', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const strings = { type: 'array', items: string };
const array = items => ({ type: 'array', items });
const object = properties => ({ type: 'object', properties, additionalProperties: true });

const evidenceProperties = {
  status: nullableString,
  audit: nullableString,
  evidence: strings
};

const requirement = object({
  component: string,
  metric: string,
  value: {
    type: ['number', 'string', 'boolean', 'null'],
    description: 'Publisher value, unchanged. Missing or null does not mean zero.'
  },
  min: nullableNumber,
  max: nullableNumber,
  unit: { ...nullableString, description: 'Original published unit; never converted.' },
  qualifier: string,
  notes: nullableString,
  source: string
});

const hardwareProfile = object({
  id: string,
  role: string,
  level: string,
  scope: string,
  client: nullableString,
  clientVersion: nullableString,
  deployment: string,
  verification: { ...string, description: 'Includes unresolved profiles; these are unverified.' },
  notes: nullableString,
  verificationNotes: nullableString,
  evidence: strings,
  requirements: array(requirement),
  requiredWhen: nullableString,
  sizing: nullableString,
  historicalStateEra: nullableString,
  prerequisiteFor: array(object({
    role: string, requiredWhen: string, sizing: string, notes: nullableString, sources: strings
  })),
  snapshotArtifact: object({
    file: string,
    type: string,
    url: string,
    publishedAt: nullableString,
    sizes: array(object({ value: nullableNumber, unit: string, source: string }))
  }),
  dependencies: array(object({
    component: string,
    requiredWhen: nullableString,
    clientOptions: strings,
    selfHosted: { type: 'boolean' },
    hosting: nullableString,
    sizing: nullableString,
    notes: nullableString,
    sources: strings
  }))
});

const research = {
  ...object({
    family: nullableString,
    coverage: nullableString,
    auditStatus: nullableString,
    checkedAt: nullableString,
    updatedAt: nullableString,
    repositories: array(object({
      url: string, repo: nullableString, kind: string, kindLabel: string, ...evidenceProperties
    })),
    papers: array(object({ url: string, title: string, ...evidenceProperties })),
    features: array(object({ text: string, ...evidenceProperties })),
    forums: array(object({
      url: string,
      title: string,
      type: string,
      relationship: string,
      scope: string,
      access: string,
      activity: string,
      lastActivity: nullableString,
      verification: string,
      notes: nullableString,
      evidence: strings
    })),
    forumsCheckedAt: nullableString,
    forumsStatus: nullableString,
    channels: array(object({
      platform: string,
      url: string,
      canonicalUrl: nullableString,
      title: string,
      mode: string,
      audience: strings,
      language: nullableString,
      relationship: string,
      scope: string,
      access: string,
      invitation: string,
      lastActivity: nullableString,
      alternateInvites: strings,
      verification: string,
      notes: nullableString,
      evidence: strings,
      activity: { ...nullableString, description: 'Research-time activity assessment, not current responsiveness.' },
      checkedAt: nullableString,
      evidenceMode: nullableString,
      current_availability_checks: {
        ...array(object({
          platform: string,
          url: string,
          checked_at_utc: nullableString,
          status: string,
          observed_title: nullableString,
          resolved_url: nullableString,
          evidence_urls: strings,
          activity_status: nullableString,
          latest_observed_activity: nullableString,
          observed_historical_status: nullableString,
          notes: nullableString,
          evidence_mode: nullableString
        })),
        description: 'Optional raw availability evidence, preserved verbatim; not a live probe.'
      },
      independent_verification: {
        ...object({ checked_at_utc: nullableString, status: string, source_urls: strings, evidence_mode: nullableString, notes: nullableString }),
        description: 'Optional raw independent-verification metadata, preserved verbatim.'
      }
    })),
    channelsCheckedAt: nullableString,
    channelsIdentityStatus: nullableString,
    channelsStatus: nullableString,
    hardware: {
      ...object({
        status: nullableString,
        identityStatus: nullableString,
        checkedAt: nullableString,
        notes: nullableString,
        sources: array(object({ url: string, title: nullableString, access: nullableString, notes: nullableString })),
        profiles: array(hardwareProfile)
      }),
      description: 'Static research, including status, notes and sources when no sizing profile was found. All profiles are retained, including unresolved and conditionally required unsized components.'
    }
  }),
  description: 'Detail-only audited research. Optional source metadata is retained at every level. Absent if no research items or hardware research entry exist; omitted from list and search responses.'
};

export const chainDetailSchema = {
  ...object({
    chainId: { type: 'integer' },
    name: string,
    shortName: nullableString,
    'theGraph-id': string,
    fullName: nullableString,
    caip2Id: string,
    aliases: strings,
    nativeCurrency: object({ name: string, symbol: string, decimals: { type: 'integer' } }),
    explorers: array({
      anyOf: [string, object({ name: string, url: string, standard: nullableString, icon: nullableString })]
    }),
    infoURL: string,
    infoURLSource: string,
    registryInfoURL: nullableString,
    family: string,
    sources: strings,
    tags: strings,
    status: string,
    statusReason: string,
    bridges: array({ anyOf: [string, object({ url: string })] }),
    forumUrl: string,
    l2Beat: object({
      slug: string,
      displayName: string,
      stage: nullableString,
      category: nullableString,
      stack: nullableString,
      daLayer: nullableString,
      hostChainId: { type: ['integer', 'null'] },
      purposes: strings,
      tvs: nullableNumber,
      tvsBreakdown: { description: 'L2BEAT value-secured breakdown, when available.' },
      activity: { description: 'L2BEAT activity metrics, when available.' },
      links: { description: 'L2BEAT project links, when available.' },
      riskView: { description: 'L2BEAT risk assessment, when available.' },
      milestones: { description: 'L2BEAT project milestones, when available.' },
      dataFreshness: string,
      fetchedAt: nullableString
    }),
    defillama: object({
      name: string,
      aliases: strings,
      website: nullableString,
      twitter: nullableString,
      github: strings,
      symbol: nullableString,
      gasTokenSymbol: nullableString,
      geckoId: nullableString,
      gasTokenGeckoId: nullableString,
      cmcId: nullableString,
      categories: strings,
      parent: {
        ...object({ chain: string, types: strings, da: nullableString }),
        type: ['object', 'null']
      },
      deprecated: { type: 'boolean' },
      deadFrom: nullableString,
      dataFreshness: string,
      fetchedAt: nullableString
    }),
    research,
    price: {
      ...object({
        usd: { type: 'number' },
        vol24h: nullableNumber,
        marketCap: nullableNumber,
        asOf: nullableString,
        stale: { type: 'boolean' },
        updatedAt: string
      }),
      type: ['object', 'null'],
      description: 'Native-asset USD quote, or null when unavailable. Stale quotes retain price and age but null volume and market cap.'
    }
  }),
  required: ['chainId', 'price'],
  description: 'A single chain metadata projection, with optional static research and native-asset price. RPC endpoints and relations have separate routes.'
};

export const chainErrorSchema = {
  type: 'object',
  properties: { error: string },
  required: ['error']
};
