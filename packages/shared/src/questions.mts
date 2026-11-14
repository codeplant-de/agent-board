// Questions an agent asks through `board ask`, shaped like Claude Code's AskUserQuestion, and the answers the UI sends back.
import { isRecord } from './guards.mts';

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_CHARS = 16;

export interface QuestionOption {
  label: string;
  description: string;
  recommended?: boolean;
}

export interface Question {
  // A short chip, such as "Scope" or "Auth method".
  header: string;
  question: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface Answer {
  // Labels of the chosen options; empty when only `other` was given.
  selected: string[];
  // Free text, instead of or next to the options.
  other?: string;
}

export class QuestionError extends Error {}

function text(obj: Record<string, unknown>, key: string, what: string, required = true): string {
  const value = obj[key];
  if (typeof value !== 'string') throw new QuestionError(`${what}.${key} must be a string`);
  if (required && value.trim() === '') throw new QuestionError(`${what}.${key} must not be empty`);
  return value.trim();
}

function parseOption(value: unknown, what: string): QuestionOption {
  if (!isRecord(value)) throw new QuestionError(`${what} must be an object`);
  const option: QuestionOption = {
    label: text(value, 'label', what),
    description: text(value, 'description', what, false),
  };
  if ('recommended' in value) {
    if (typeof value['recommended'] !== 'boolean') throw new QuestionError(`${what}.recommended must be a boolean`);
    if (value['recommended']) option.recommended = true;
  }
  return option;
}

function parseQuestion(value: unknown, what: string): Question {
  if (!isRecord(value)) throw new QuestionError(`${what} must be an object`);
  const header = text(value, 'header', what);
  if (header.length > MAX_HEADER_CHARS)
    throw new QuestionError(`${what}.header must be at most ${MAX_HEADER_CHARS} characters`);
  const multiSelect = value['multiSelect'] ?? false;
  if (typeof multiSelect !== 'boolean') throw new QuestionError(`${what}.multiSelect must be a boolean`);
  const rawOptions = value['options'];
  if (!Array.isArray(rawOptions) || rawOptions.length < MIN_OPTIONS || rawOptions.length > MAX_OPTIONS) {
    throw new QuestionError(`${what}.options must hold ${MIN_OPTIONS} to ${MAX_OPTIONS} options`);
  }
  const options = rawOptions.map((option, index) => parseOption(option, `${what}.options[${index}]`));
  const labels = new Set(options.map((option) => option.label));
  if (labels.size !== options.length) throw new QuestionError(`${what}.options must have different labels`);
  if (options.filter((option) => option.recommended).length > 1)
    throw new QuestionError(`${what} may recommend one option at most`);
  return { header, question: text(value, 'question', what), multiSelect, options };
}

// Accepts the list itself or `{"questions": [...]}`, the shape the agent writes to its file.
export function parseQuestions(value: unknown): Question[] {
  const list = isRecord(value) ? value['questions'] : value;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_QUESTIONS) {
    throw new QuestionError(`expected 1 to ${MAX_QUESTIONS} questions`);
  }
  return list.map((question, index) => parseQuestion(question, `questions[${index}]`));
}

// With `questions`, each answer is checked against its question: known labels, one at most for a single choice, and something chosen or written.
export function parseAnswers(questions: Question[] | undefined, value: unknown): Answer[] {
  if (!Array.isArray(value)) throw new QuestionError('answers must be a list');
  if (questions !== undefined && value.length !== questions.length)
    throw new QuestionError(`expected ${questions.length} answers, got ${value.length}`);
  return value.map((item, index) => {
    const what = `answers[${index}]`;
    if (!isRecord(item)) throw new QuestionError(`${what} must be an object`);
    const selected = item['selected'];
    if (!Array.isArray(selected) || !selected.every((label) => typeof label === 'string'))
      throw new QuestionError(`${what}.selected must be a list of labels`);
    const answer: Answer = { selected: [...new Set(selected)] };
    if ('other' in item && item['other'] !== undefined) {
      const other = item['other'];
      if (typeof other !== 'string') throw new QuestionError(`${what}.other must be a string`);
      if (other.trim() !== '') answer.other = other.trim();
    }
    const question = questions?.[index];
    if (question !== undefined) {
      const known = new Set(question.options.map((option) => option.label));
      const unknown = answer.selected.find((label) => !known.has(label));
      if (unknown !== undefined)
        throw new QuestionError(`${what}: "${unknown}" is not an option of "${question.header}"`);
      if (!question.multiSelect && answer.selected.length > 1)
        throw new QuestionError(`${what}: "${question.header}" takes one option`);
      // Picking none of several is an answer; a single choice needs a pick or a text.
      if (!question.multiSelect && answer.selected.length === 0 && answer.other === undefined)
        throw new QuestionError(`${what}: "${question.header}" needs an option or a text`);
    }
    return answer;
  });
}

// One line per question, for the resume prompt and the thread: `Header: question → Option A, Option B; other text`.
export function formatAnswers(questions: Question[] | undefined, answers: Answer[]): string {
  return answers
    .map((answer, index) => {
      const question = questions?.[index];
      const asked = question ? `${question.header}: ${question.question}` : `Question ${index + 1}`;
      const given =
        [answer.selected.join(', '), answer.other ?? ''].filter((part) => part !== '').join('; ') || '(none)';
      return `- ${asked} → ${given}`;
    })
    .join('\n');
}

// The question as markdown, for `board show` and Slack.
export function formatQuestions(questions: Question[]): string {
  return questions
    .map((question) => {
      const options = question.options.map(
        (option) =>
          `  - ${option.label}${option.recommended ? ' (recommended)' : ''}${option.description ? `: ${option.description}` : ''}`,
      );
      return [
        `- **${question.header}**: ${question.question}${question.multiSelect ? ' (several)' : ''}`,
        ...options,
      ].join('\n');
    })
    .join('\n');
}
