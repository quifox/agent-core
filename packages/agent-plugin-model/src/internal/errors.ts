import { AGENT_ERROR_CODE, AGENT_ERROR_PHASE } from '@quifox/agent-core'

/** Protocol-specific error metadata belongs to the model implementation. */
export const MODEL_ERROR_CODE = {
    ...AGENT_ERROR_CODE,
    PROVIDER_PROTOCOL_ERROR: 'PROVIDER_PROTOCOL_ERROR'
} as const

export const MODEL_ERROR_PHASE = {
    ...AGENT_ERROR_PHASE,
    PROVIDER: 'provider'
} as const
