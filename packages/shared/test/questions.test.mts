import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatAnswers, parseAnswers, parseQuestions, QuestionError } from '../src/questions.mts';

const scope = {
  header: 'Scope',
  question: 'Review the migration too?',
  options: [
    { label: 'Yes', description: 'Include it', recommended: true },
    { label: 'No', description: 'Skip it' },
  ],
};

test('questions come as a list or wrapped, and multiSelect defaults to false', () => {
  const [question] = parseQuestions({ questions: [scope] });
  assert.equal(question?.multiSelect, false);
  assert.deepEqual(parseQuestions([scope]), parseQuestions({ questions: [scope] }));
});

test('bad questions are refused with a reason', () => {
  assert.throws(() => parseQuestions([]), QuestionError);
  assert.throws(() => parseQuestions([{ ...scope, options: [scope.options[0]] }]), /2 to 4 options/);
  assert.throws(() => parseQuestions([{ ...scope, header: 'A header that is far too long' }]), /at most/);
  assert.throws(
    () => parseQuestions([{ ...scope, options: [scope.options[0], scope.options[0]] }]),
    /different labels/,
  );
  assert.throws(
    () => parseQuestions([{ ...scope, options: scope.options.map((o) => ({ ...o, recommended: true })) }]),
    /one option at most/,
  );
});

test('answers are checked against their questions', () => {
  const questions = parseQuestions([scope]);
  assert.deepEqual(parseAnswers(questions, [{ selected: ['Yes'] }]), [{ selected: ['Yes'] }]);
  assert.deepEqual(parseAnswers(questions, [{ selected: [], other: ' only the schema ' }]), [
    { selected: [], other: 'only the schema' },
  ]);
  assert.throws(() => parseAnswers(questions, [{ selected: ['Maybe'] }]), /not an option/);
  assert.throws(() => parseAnswers(questions, [{ selected: ['Yes', 'No'] }]), /takes one option/);
  assert.throws(() => parseAnswers(questions, [{ selected: [] }]), /needs an option or a text/);
  assert.throws(() => parseAnswers(questions, []), /expected 1 answers/);
  const several = parseQuestions([{ ...scope, multiSelect: true }]);
  assert.deepEqual(parseAnswers(several, [{ selected: [] }]), [{ selected: [] }]);
  assert.equal(formatAnswers(several, [{ selected: [] }]), '- Scope: Review the migration too? → (none)');
});

test('answers format as one line per question', () => {
  const questions = parseQuestions([scope]);
  assert.equal(
    formatAnswers(questions, [{ selected: ['Yes'], other: 'and the seed' }]),
    '- Scope: Review the migration too? → Yes; and the seed',
  );
});
