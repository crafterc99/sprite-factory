// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { detectQuestion, cleanQuestion, buildChoices } from '../src/content/question-detector.js';
import { isSensitiveField, scrub } from '../src/content/extractor.js';

const set = (html) => { document.body.innerHTML = html; };
const detect = () => detectQuestion(document);
const ids = (r) => r.payload.choices.map((c) => `${c.id}:${c.text}`);

beforeEach(() => { document.body.innerHTML = ''; });

describe('question detection', () => {
  it('radio group in fieldset + legend, with A. prefixes stripped into ids', () => {
    set(`<fieldset><legend>What planet is largest?</legend>
      <label><input type=radio name=q value=a> A. Earth</label>
      <label><input type=radio name=q value=b> B. Mars</label>
      <label><input type=radio name=q value=c> C. Jupiter</label>
      <label><input type=radio name=q value=d> D. Venus</label></fieldset>`);
    const r = detect();
    expect(r.found).toBe(true);
    expect(r.payload.question).toBe('What planet is largest?');
    expect(ids(r)).toEqual(['A:Earth', 'B:Mars', 'C:Jupiter', 'D:Venus']);
    expect(r.payload.fingerprint).toMatch(/^[0-9a-f]{24}$/);
  });

  it('radios with label[for], no prefixes: letters assigned', () => {
    set(`<div><p>Which gas do plants absorb?</p>
      <input type=radio id=a name=g><label for=a>Oxygen</label>
      <input type=radio id=b name=g><label for=b>Carbon dioxide</label></div>`);
    const r = detect();
    expect(r.payload.question).toBe('Which gas do plants absorb?');
    expect(ids(r)).toEqual(['A:Oxygen', 'B:Carbon dioxide']);
  });

  it('numbered prefixes give numeric ids', () => {
    set(`<div class="quiz"><h3>Pick the prime number</h3><ul>
      <li><button>1. Four</button></li><li><button>2. Six</button></li><li><button>3. Seven</button></li></ul></div>`);
    const r = detect();
    expect(ids(r)).toEqual(['1:Four', '2:Six', '3:Seven']);
  });

  it('Moodle-style markup', () => {
    set(`<div class="que multichoice"><div class="info"><h3 class="no">Question <span class="qno">3</span></h3></div>
      <div class="content"><div class="formulation"><div class="qtext"><p>What is the capital of France?</p></div>
      <div class="ablock"><div class="answer">
        <div class="r0"><input type="radio" name="q1" id="q1a0"><label for="q1a0"><span class="answernumber">a. </span>Berlin</label></div>
        <div class="r1"><input type="radio" name="q1" id="q1a1"><label for="q1a1"><span class="answernumber">b. </span>Paris</label></div>
        <div class="r0"><input type="radio" name="q1" id="q1a2"><label for="q1a2"><span class="answernumber">c. </span>Rome</label></div>
      </div></div></div></div></div>`);
    const r = detect();
    expect(r.payload.question).toBe('What is the capital of France?');
    expect(ids(r)).toEqual(['A:Berlin', 'B:Paris', 'C:Rome']);
  });

  it('Canvas-style markup (.question_text + answers)', () => {
    set(`<div class="question"><div class="question_text user_content"><p>2 + 2 = ?</p></div>
      <div class="answers"><div class="answer"><input type=radio name=x id=x1><label for=x1>3</label></div>
      <div class="answer"><input type=radio name=x id=x2><label for=x2>4</label></div></div></div>`);
    const r = detect();
    expect(r.payload.question).toBe('2 + 2 = ?');
    expect(ids(r)).toEqual(['A:3', 'B:4']);
  });

  it('ARIA radiogroup / listbox', () => {
    set(`<div role=radiogroup aria-label="Largest ocean on Earth?">
      <div role=radio>Atlantic</div><div role=radio>Pacific</div><div role=radio>Indian</div></div>`);
    expect(ids(detect())).toEqual(['A:Atlantic', 'B:Pacific', 'C:Indian']);
    set(`<h2>Pick a colour of the rainbow</h2><ul role=listbox><li role=option>Red</li><li role=option>Brown</li></ul>`);
    const r = detect();
    expect(r.found).toBe(true);
    expect(r.payload.question).toBe('Pick a colour of the rainbow');
  });

  it('React-like buttons under a question heading', () => {
    set(`<div id=root><div class="quiz-card"><h2>Which is a mammal?</h2><div class="options">
      <button class="option">Shark</button><button class="option">Dolphin</button><button class="option">Trout</button></div>
      <button id=next>Next</button></div></div>`);
    const r = detect();
    expect(ids(r)).toEqual(['A:Shark', 'B:Dolphin', 'C:Trout']);
  });

  it('plain-text options in one paragraph', () => {
    set(`<div><p>Question 4 of 10</p><p>Who wrote Hamlet?<br>A. Marlowe<br>B. Shakespeare<br>C. Jonson</p></div>`);
    const r = detect();
    expect(r.payload.question).toBe('Who wrote Hamlet?');
    expect(ids(r)).toEqual(['A:Marlowe', 'B:Shakespeare', 'C:Jonson']);
  });

  it('strips question numbering so a repeated question keeps the same contentKey', () => {
    const make = (n) => `<fieldset><legend>Question ${n}: What planet is largest? (1 point)</legend>
      <label><input type=radio name=q> Earth</label><label><input type=radio name=q> Jupiter</label></fieldset>`;
    set(make(3)); const a = detect().payload;
    set(make(9)); const b = detect().payload;
    expect(a.question).toBe('What planet is largest?');
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it('ignores hidden questions', () => {
    set(`<div style="display:none"><fieldset><legend>Hidden question here?</legend>
      <label><input type=radio name=q> Yes</label><label><input type=radio name=q> No</label></fieldset></div>`);
    expect(detect().found).toBe(false);
  });

  it('ignores navigation menus and toolbars', () => {
    set(`<nav><ul><li><a>Home</a></li><li><a>About</a></li><li><a>Contact</a></li></ul></nav>
      <div><button>Bold</button><button>Italic</button></div>`);
    expect(detect().found).toBe(false);
  });

  it('reports visual content when only a canvas is present', () => {
    set(`<canvas width=300 height=200></canvas>`);
    expect(detect()).toEqual({ found: false, visual: true });
  });

  it('never includes password/card fields or their values, and scrubs secrets in context', () => {
    set(`<form><p>Card 4111 1111 1111 1111 for jane@example.com token sk-abcdefghijklmnopqrstuvwx</p>
      <input type=password value="hunter2"><input name=cardnumber value="4111111111111111">
      <fieldset><legend>Is the sky blue?</legend>
      <label><input type=radio name=q value=SECRETVALUE> Yes</label><label><input type=radio name=q> No</label></fieldset></form>`);
    const blob = JSON.stringify(detect());
    expect(blob).not.toMatch(/hunter2|4111|jane@example|sk-abcdef|SECRETVALUE/);
  });

  it('does not treat a payment-method radio group as a question', () => {
    set(`<fieldset><legend>Payment method for order</legend>
      <label><input type=radio name=card_type> Visa</label><label><input type=radio name=card_type> Mastercard</label></fieldset>`);
    expect(detect().found).toBe(false);
  });

  it('strips query string and hash from the url', () => {
    set(`<fieldset><legend>Is water wet?</legend><label><input type=radio name=q> Yes</label><label><input type=radio name=q> No</label></fieldset>`);
    history.replaceState({}, '', '/quiz?token=SECRET#frag');
    expect(detect().payload.url).not.toMatch(/SECRET|frag|\?/);
  });

  it('includes only short nearby context', () => {
    set(`<section><p>Read: The Sun is a star at the centre of the Solar System.</p>
      <fieldset><legend>What is the Sun?</legend><label><input type=radio name=q> A star</label><label><input type=radio name=q> A planet</label></fieldset></section>
      <footer>Copyright junk footer</footer>`);
    const p = detect().payload;
    expect(p.context).toContain('The Sun is a star');
    expect(p.context).not.toContain('footer');
    expect(p.context.length).toBeLessThanOrEqual(500);
  });
});

describe('helpers', () => {
  it('isSensitiveField', () => {
    document.body.innerHTML = '<input type=password id=a><input id=b type=text autocomplete="cc-number"><input id=c type=radio name=q><input id=d type=hidden>';
    const g = (id) => document.getElementById(id);
    expect([g('a'), g('b'), g('c'), g('d')].map(isSensitiveField)).toEqual([true, true, false, true]);
  });
  it('scrub redacts card numbers and emails', () => {
    expect(scrub('call 4111 1111 1111 1111 or a@b.co')).toBe('call [redacted] or [email]');
  });
  it('cleanQuestion / buildChoices', () => {
    expect(cleanQuestion('Question 2 of 10\nWhat is 2+2?\n1 point')).toBe('What is 2+2?');
    expect(buildChoices(['A. x', 'B. y']).map((c) => c.id)).toEqual(['A', 'B']);
    expect(buildChoices(['x', 'y', 'z']).map((c) => c.id)).toEqual(['A', 'B', 'C']);
    expect(buildChoices(['A. x', 'C. y']).map((c) => c.text)).toEqual(['A. x', 'C. y']); // non-sequential prefixes are left alone
  });
});
