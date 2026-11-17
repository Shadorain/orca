import { describe, expect, it } from 'vitest'
import { acpElicitationPresentation } from './acp-elicitation-requests'

const request = {
  sessionId: 'mission-session',
  mode: 'form',
  message: 'Review the plan',
  requestedSchema: {
    type: 'object',
    required: ['count', 'note'],
    properties: {
      count: { type: 'number', title: 'Count', default: 0 },
      note: { type: 'string', title: 'Note' },
      secret: { type: 'string', hidden: true, default: 'keep' },
      flags: { type: 'array', default: [] },
      approved: { type: 'boolean', default: false }
    }
  }
}

describe('ACP elicitation defaults', () => {
  it('hides schema fields and keeps zero, false, and empty defaults', () => {
    const presentation = acpElicitationPresentation(request)
    const questions = 'questions' in presentation.body ? (presentation.body.questions ?? []) : []
    expect(questions.map((question) => question.id)).toEqual(['count', 'note', 'flags', 'approved'])
    expect(presentation.reply(null)).toEqual({ action: 'cancel' })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [{ questionId: 'note', optionIds: [], other: 'ship' }]
      })
    ).toEqual({
      action: 'accept',
      content: {
        note: 'ship',
        count: 0,
        secret: 'keep',
        flags: [],
        approved: false
      }
    })
  })
  it('reads the sender item-choice schema and preserves selected array values and explicit empties', () => {
    const presentation = acpElicitationPresentation({
      sessionId: 'mission-session',
      mode: 'form',
      message: 'Set values',
      requestedSchema: {
        type: 'object',
        required: ['labels', 'note', 'approved', 'count', 'style'],
        properties: {
          labels: {
            type: 'array',
            items: {
              anyOf: [
                { const: 'red,blue', title: 'Red and blue' },
                { const: 'green', title: 'Green' }
              ]
            },
            default: ['red,blue']
          },
          note: { type: 'string', default: 'prefilled' },
          approved: { type: 'boolean', default: true },
          count: { type: 'number', default: 4 },
          style: {
            type: 'string',
            oneOf: [
              { const: 'casual', title: 'Casual' },
              { const: 'formal', title: 'Formal' }
            ],
            default: 'casual'
          },
          hidden: { type: 'string', hidden: true, default: 'host-value' }
        }
      }
    })
    const questions = 'questions' in presentation.body ? (presentation.body.questions ?? []) : []
    expect(questions[0]).toMatchObject({
      id: 'labels',
      multiSelect: true,
      options: [
        { id: 'red,blue', label: 'Red and blue' },
        { id: 'green', label: 'Green' }
      ],
      initialOptionIds: ['red,blue'],
      allowEmptySelection: true
    })
    expect(questions[4]).toMatchObject({ id: 'style', initialOptionIds: ['casual'] })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'labels', optionIds: ['red,blue', 'green'] },
          { questionId: 'note', optionIds: [], other: '' },
          { questionId: 'approved', optionIds: ['false'] },
          { questionId: 'count', optionIds: [], other: '0' },
          { questionId: 'style', optionIds: ['formal'] },
          { questionId: 'hidden', optionIds: [], other: 'attacker-value' }
        ]
      })
    ).toEqual({
      action: 'accept',
      content: {
        labels: ['red,blue', 'green'],
        note: '',
        approved: false,
        count: 0,
        style: 'formal',
        hidden: 'host-value'
      }
    })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [
          { questionId: 'labels', optionIds: [] },
          { questionId: 'note', optionIds: [], other: '' },
          { questionId: 'approved', optionIds: ['false'] },
          { questionId: 'count', optionIds: [], other: '0' },
          { questionId: 'style', optionIds: ['formal'] },
          { questionId: 'hidden', optionIds: [], other: 'attacker-value' }
        ]
      })
    ).toMatchObject({
      action: 'accept',
      content: { labels: [], note: '', approved: false, count: 0, style: 'formal' }
    })
  })

  it('allows an explicitly empty single-field choice array', () => {
    const presentation = acpElicitationPresentation({
      sessionId: 'mission-session',
      mode: 'form',
      message: 'Choose labels',
      requestedSchema: {
        type: 'object',
        properties: {
          labels: {
            type: 'array',
            items: { anyOf: [{ const: 'red,blue', title: 'Red and blue' }] },
            default: ['red,blue']
          }
        }
      }
    })
    expect(presentation.body).toMatchObject({
      kind: 'question',
      questionId: 'labels',
      multiSelect: true,
      allowEmptySelection: true,
      initialOptionIds: ['red,blue']
    })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [{ questionId: 'labels', optionIds: [] }]
      })
    ).toEqual({ action: 'accept', content: { labels: [] } })
  })

  it('offers an explicit submit question when the schema has only hidden fields', () => {
    const presentation = acpElicitationPresentation({
      sessionId: 'mission-session',
      mode: 'form',
      message: 'Confirm hidden-only form',
      requestedSchema: {
        type: 'object',
        required: ['secret'],
        properties: {
          secret: { type: 'string', hidden: true, default: 'host-value' }
        }
      }
    })
    expect(presentation.body).toMatchObject({
      kind: 'question',
      questions: [
        {
          id: '__submit_form__',
          question: 'Confirm hidden-only form',
          options: [],
          multiSelect: true,
          allowEmptySelection: true
        }
      ]
    })
    expect(presentation.reply(null)).toEqual({ action: 'cancel' })
    expect(
      presentation.reply({
        kind: 'answers',
        answers: [{ questionId: '__submit_form__', optionIds: [] }]
      })
    ).toEqual({ action: 'accept', content: { secret: 'host-value' } })
  })

  it('renders a single field default as an initial choice', () => {
    const presentation = acpElicitationPresentation({
      sessionId: 'mission-session',
      mode: 'form',
      message: 'Choose',
      requestedSchema: {
        type: 'object',
        properties: { accepted: { type: 'boolean', default: false } }
      }
    })
    expect(presentation.body).toMatchObject({
      multiSelect: false,
      initialOptionIds: ['false']
    })
    expect(presentation.reply({ kind: 'option', optionId: 'false' })).toEqual({
      action: 'accept',
      content: { accepted: false }
    })
  })

  it('still rejects a required field that has no default', () => {
    const presentation = acpElicitationPresentation(request)
    expect(() =>
      presentation.reply({
        kind: 'answers',
        answers: [{ questionId: 'count', optionIds: ['0'], other: undefined }]
      })
    ).toThrow('Elicitation answer must address the requested fields')
  })
})
