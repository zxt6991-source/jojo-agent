import { describe, expect, it } from 'vitest';
import { shouldDisableAutoRead } from './speech-output-policy';

describe('explicit spoken reply preferences', () => {
  it.each([
    '我没说读出来不要自己读',
    '不要直接阅读出来',
    '除非我明确说朗读，否则只给文字',
    '英语怎么学，不要自动朗读',
    '请解释 TTS 是怎么实现的，只给文字',
    '把这段翻译成英文，只用文字回复',
    '我没有让你读出来，不要自己读。',
    '请不要自动朗读',
    '不要再自动朗读了',
    '以后不要主动朗读回复，谢谢。',
    '你别擅自读出来',
    '不需要你自动读出来',
    '我不想要语音回复',
    '不用语音回答',
    '别出声',
    '停止朗读',
    '关闭自动朗读',
    '请把语音关闭，不要读出来。',
    '不要把回复读出来',
    '只用文字回复',
    '仅文本回答',
    '文字回答就好',
    '只要文字',
    '只用文字',
    '只回复文字',
    '不要用语音读出来',
    '请不要自动朗读“hello”',
    "Please don't read aloud.",
    'Don’t read this out loud.',
    'Do not automatically read aloud',
    'No need to read it aloud',
    "Don't use voice replies",
    'Stop reading aloud please',
    'Stop speaking',
    'Disable automatic voice replies',
    'Turn off TTS',
    'Reply in text only',
    'Only respond with plain text',
    'Text only please'
  ])('disables automatic speech for %s', text => {
    expect(shouldDisableAutoRead(text)).toBe(true);
  });

  it.each([
    '',
    '请朗读这段回答',
    '我用语音输入，但不想修改配置',
    '不要朗读代码',
    '不要自动朗读代码，继续读解释。',
    '不要读英文，只读中文',
    '不要把文件删掉，然后朗读回复',
    '不要联网，解释 TTS 是什么',
    'TTS 自动朗读是怎么实现的？',
    '如何关闭自动朗读？',
    '关闭自动朗读会影响提醒吗？',
    '请把“不要自动朗读”翻译成英文',
    '翻译成英文：不要自动朗读',
    '他说不要自己读',
    '例如，不要自动朗读',
    '> 不要自动朗读\n这句话是什么含义？',
    '`不要自动朗读` 是一个输入示例',
    '```text\n不要自己读\n```',
    '如何表达不要语音回复',
    "Translate 'don't read aloud' into Chinese.",
    'Translate into Chinese: don’t read aloud',
    'What does stop reading aloud mean?',
    "Don't read the code aloud, just explain it.",
    "Don't delete the file; read the response aloud.",
    'How to disable automatic voice replies?',
    'He said stop speaking',
    'Does text only improve performance?',
    '请每分钟用语音提醒我喝水'
  ])('does not change automatic speech for %s', text => {
    expect(shouldDisableAutoRead(text)).toBe(false);
  });

  it('honors a stop request before a separate translation request', () => {
    expect(shouldDisableAutoRead('不要朗读，然后把“hello”翻译成中文。')).toBe(true);
  });
});
