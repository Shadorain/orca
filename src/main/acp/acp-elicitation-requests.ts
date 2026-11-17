import { z } from 'zod'
import type { AcpRequestPresentation } from './acp-dialects/acp-dialect'
import { AcpRpcError } from './acp-errors'

export const pendingAcpResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
} as const

const elicitationChoiceSchema = z.object({
  const: z.string(),
  title: z.string().optional()
})

const elicitationPropertySchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'array']),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  enumNames: z.array(z.string()).optional(),
  oneOf: z.array(elicitationChoiceSchema).optional(),
  items: z
    .object({
      enum: z.array(z.string()).optional(),
      enumNames: z.array(z.string()).optional(),
      anyOf: z.array(elicitationChoiceSchema).optional()
    })
    .optional(),
  default: z.unknown().optional(),
  hidden: z.boolean().optional()
})

const elicitationRequestSchema = z.object({
  sessionId: z.string(),
  message: z.string(),
  mode: z.enum(['form', 'url']),
  requestedSchema: z
    .object({
      type: z.literal('object'),
      properties: z.record(z.string(), elicitationPropertySchema),
      required: z.array(z.string()).optional()
    })
    .optional()
})

type ElicitationProperty = z.infer<typeof elicitationPropertySchema>
function elicitationChoices(property: ElicitationProperty): { value: string; label: string }[] {
  if (property.type === 'array') {
    const choices =
      property.items?.anyOf ??
      property.items?.enum?.map((value, index) => ({
        const: value,
        title: property.items?.enumNames?.[index]
      })) ??
      []
    return choices.map(({ const: value, title }) => ({ value, label: title ?? value }))
  }
  const choices =
    property.oneOf ??
    property.enum?.map((value, index) => ({
      const: value,
      title: property.enumNames?.[index]
    })) ??
    []
  return choices.map(({ const: value, title }) => ({ value, label: title ?? value }))
}

/** Translates one schema property into a journal question. Enum values become option ids;
 *  booleans become yes/no; everything else is free text the reply reads back as a string. */
function elicitationQuestion(
  key: string,
  property: ElicitationProperty
): {
  id: string
  question: string
  options: { id: string; label: string }[]
  multiSelect: boolean
  initialOptionIds?: string[]
  allowEmptySelection?: boolean
  freeTextQuestionId?: string
  freeTextInput?: { allowEmpty?: boolean; initialValue?: string }
} {
  const question = property.title ?? key
  const choices = elicitationChoices(property)
  const values = choices.map(({ value }) => value)
  const arrayEnum = property.type === 'array' && values.length > 0
  const options = choices.map(({ value, label }) => ({ id: value, label }))
  const base = {
    id: key,
    question,
    options,
    multiSelect: arrayEnum
  }
  if (arrayEnum) {
    const initialOptionIds = Array.isArray(property.default)
      ? property.default.filter(
          (value): value is string => typeof value === 'string' && values.includes(value)
        )
      : []
    return {
      ...base,
      allowEmptySelection: true,
      ...(initialOptionIds.length > 0 ? { initialOptionIds } : {})
    }
  }
  if (values.length > 0) {
    const initialOptionIds =
      typeof property.default === 'string' && values.includes(property.default)
        ? [property.default]
        : []
    return {
      ...base,
      multiSelect: false,
      ...(initialOptionIds.length > 0 ? { initialOptionIds } : {})
    }
  }
  if (property.type === 'boolean') {
    return {
      ...base,
      multiSelect: false,
      options: [
        { id: 'true', label: 'Yes' },
        { id: 'false', label: 'No' }
      ],
      ...(typeof property.default === 'boolean'
        ? { initialOptionIds: [String(property.default)] }
        : {})
    }
  }
  return {
    ...base,
    options: [],
    freeTextQuestionId: key,
    freeTextInput: {
      ...(property.type === 'string' ? { allowEmpty: true } : {}),
      ...(typeof property.default === 'string' || typeof property.default === 'number'
        ? { initialValue: String(property.default) }
        : Array.isArray(property.default)
          ? { initialValue: JSON.stringify(property.default) }
          : {})
    }
  }
}

/** An `unstable_createElicitation` form request as a journal question the operator answers.
 *  The reply rebuilds the content object the agent asked for; a dismissal cancels. URL mode is
 *  refused: Orca never advertises it, so an agent sending one is its own misstep. */
export function acpElicitationPresentation(params: unknown): AcpRequestPresentation {
  const request = elicitationRequestSchema.safeParse(params)
  if (!request.success) {
    throw new AcpRpcError(-32602, 'Invalid ACP elicitation request')
  }
  if (request.data.mode !== 'form') {
    throw new AcpRpcError(-32602, 'ACP elicitation URL mode is not supported')
  }
  const properties = request.data.requestedSchema?.properties ?? {}
  const keys = Object.keys(properties).filter((key) => properties[key]?.hidden !== true)
  const visibleQuestions = keys.map((key) => elicitationQuestion(key, properties[key]!))
  const questions =
    visibleQuestions.length > 0
      ? visibleQuestions
      : [
          {
            id: '__submit_form__',
            question: request.data.message,
            options: [],
            multiSelect: true,
            allowEmptySelection: true
          }
        ]
  const single = visibleQuestions.length === 1 ? visibleQuestions[0] : undefined
  const body = single
    ? {
        kind: 'question' as const,
        question: request.data.message,
        questionId: single.id,
        options: single.options,
        multiSelect: single.multiSelect,
        ...(single.allowEmptySelection ? { allowEmptySelection: true } : {}),
        ...(single.initialOptionIds ? { initialOptionIds: single.initialOptionIds } : {}),
        ...(single.freeTextQuestionId ? { freeTextQuestionId: single.freeTextQuestionId } : {}),
        ...(single.freeTextInput ? { freeTextInput: single.freeTextInput } : {}),
        resolution: pendingAcpResolution
      }
    : {
        kind: 'question' as const,
        question: request.data.message,
        options: [],
        questions,
        resolution: pendingAcpResolution
      }
  return {
    body,
    reply: (response) => {
      if (response === null) {
        return { action: 'cancel' }
      }
      const required = new Set(request.data.requestedSchema?.required ?? [])
      const content: Record<string, unknown> = {}
      const answered = new Set<string>()
      const writeField = (
        key: string,
        property: ElicitationProperty,
        raw: string | undefined,
        optionIds: string[] = []
      ): void => {
        if (property.hidden) {
          return
        }
        const allowed = elicitationChoices(property).map(({ value }) => value)
        if (property.type === 'array' && allowed.length > 0) {
          if (optionIds.some((id) => !allowed.includes(id))) {
            throw new AcpRpcError(-32602, 'Elicitation answer must address the requested fields')
          }
          answered.add(key)
          content[key] = optionIds
          return
        }
        if (raw === undefined) {
          return
        }
        if (allowed.length > 0 && !allowed.includes(raw)) {
          throw new AcpRpcError(-32602, 'Elicitation answer must address the requested fields')
        }
        answered.add(key)
        if (property.type === 'boolean') {
          if (raw !== 'true' && raw !== 'false') {
            throw new AcpRpcError(-32602, 'Elicitation answer must address the requested fields')
          }
          content[key] = raw === 'true'
        } else if (property.type === 'number') {
          const value = Number(raw)
          if (!Number.isFinite(value)) {
            throw new AcpRpcError(-32602, 'Elicitation answer must address the requested fields')
          }
          content[key] = value
        } else if (property.type === 'array') {
          if (raw.length === 0) {
            content[key] = []
          } else {
            try {
              const value: unknown = JSON.parse(raw)
              if (!Array.isArray(value)) {
                throw new Error('not array')
              }
              content[key] = value
            } catch {
              throw new AcpRpcError(-32602, 'Elicitation answer must address the requested fields')
            }
          }
        } else {
          content[key] = raw
        }
      }
      if (single && response.kind === 'option') {
        writeField(single.id, properties[single.id]!, response.optionId, [response.optionId])
      } else if (response.kind === 'answers') {
        for (const answer of response.answers) {
          const property = properties[answer.questionId]
          if (!property) {
            continue
          }
          const selected = answer.optionIds
          const raw = answer.other ?? selected[0]
          writeField(answer.questionId, property, raw, selected)
        }
      } else {
        throw new AcpRpcError(-32602, 'Elicitation answer must address the requested fields')
      }
      for (const [key, property] of Object.entries(properties)) {
        if (property.hidden) {
          if (property.default !== undefined) {
            content[key] = property.default
            answered.add(key)
          }
        } else if (!answered.has(key) && property.default !== undefined) {
          content[key] = property.default
          answered.add(key)
        }
      }
      for (const key of required) {
        if (!answered.has(key)) {
          throw new AcpRpcError(-32602, 'Elicitation answer must address the requested fields')
        }
      }
      return { action: 'accept', content }
    }
  }
}
