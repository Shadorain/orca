import type { RefObject } from 'react'
import type { AgentJournalQuestion } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionPromptResponse } from '../../../../shared/agent-session-question-answer'
import { NativeChatQuestionCard } from './NativeChatQuestionCard'

export function NativeChatStructuredQuestionCard({
  questions,
  onAnswer,
  onCancel,
  isSubmitting,
  shouldFocus,
  answerInputRef
}: {
  questions: readonly AgentJournalQuestion[]
  onAnswer: (response: AgentSessionPromptResponse) => void
  onCancel: () => void
  isSubmitting?: boolean
  shouldFocus?: boolean
  answerInputRef?: RefObject<HTMLInputElement | null>
}): React.JSX.Element {
  return (
    <NativeChatQuestionCard
      prompt={{
        questions: questions.map((question) => ({
          question: question.question,
          ...(question.header ? { header: question.header } : {}),
          multiSelect: question.multiSelect,
          options: question.options.map((option) => ({
            label: option.label,
            ...(option.description ? { description: option.description } : {})
          })),
          ...(question.initialOptionIds
            ? {
                initialOptionIndices: question.initialOptionIds.flatMap((id) => {
                  const index = question.options.findIndex((option) => option.id === id)
                  return index !== -1 ? [index] : []
                })
              }
            : {}),
          ...(question.allowEmptySelection ? { allowEmptySelection: true } : {})
        }))
      }}
      freeTextInputs={questions.map((question) => question.freeTextInput)}
      onAnswer={(answers) => {
        const chosen = questions.map((question, index) => {
          const answer = answers[index]
          const other = question.freeTextInput?.allowEmpty ? answer?.other : answer?.other?.trim()
          return {
            questionId: question.id,
            optionIds: (answer?.indices ?? []).flatMap((optionIndex) => {
              const id = question.options[optionIndex]?.id
              return id ? [id] : []
            }),
            ...(other !== undefined && (other.length > 0 || question.freeTextInput?.allowEmpty)
              ? { other }
              : {})
          }
        })
        if (
          chosen.every(
            (answer, index) =>
              answer.optionIds.length > 0 ||
              answer.other !== undefined ||
              questions[index]?.allowEmptySelection === true
          )
        ) {
          onAnswer({ kind: 'answers', answers: chosen })
        }
      }}
      onCancel={onCancel}
      isSubmitting={isSubmitting}
      shouldFocus={shouldFocus}
      answerInputRef={answerInputRef}
    />
  )
}
