import { describe, expect, it } from 'vitest';
import { desktopSpeechInstructions, isExplicitReadAloudRequest } from '../src/output-request.js';

describe('one-turn explicit read-aloud requests', () => {
  it.each([
    '你给我朗读春花秋月何时了这首词',
    '请朗读《虞美人》',
    '帮我朗读“春花秋月何时了，往事知多少。”',
    '把这首词读出来',
    '念出来给我听',
    '这段文字读给我听',
    '念给我听',
    '请读出声',
    '把这首诗念出声',
    '读一遍这首诗',
    '请念一下这段话',
    '开始念',
    '开始读吧',
    '可以开始念了',
    '继续念',
    '接着读',
    '现在开始念给我听',
    '开始念这首词',
    '开始念《虞美人》',
    '念吧',
    '给我念一首英文诗和一首中文诗',
    '请念两首诗',
    '读一篇文章给我听',
    '帮我念《静夜思》',
    '请为我读这段文字',
    '念三段散文',
    '请朗读全文，不要摘要。',
    'Read this poem aloud.',
    'Please read the response out loud.',
    'Recite the poem.'
  ])('recognizes direct consent from %s', text => {
    expect(isExplicitReadAloudRequest(text)).toBe(true);
  });

  it.each([
    '',
    '给我介绍一下《虞美人》',
    'TTS 是怎么实现的？',
    '如何使用朗读功能？',
    '朗读按钮在哪里？',
    '解释朗读和背诵有什么区别',
    '支持朗读吗？',
    '我喜欢朗读这首词',
    '为什么不能朗读这首诗？',
    '开始念是什么意思？',
    '如何开始念？',
    '他说开始念',
    '把“开始念”翻译成英文',
    '我已经开始念了',
    '她开始念了',
    '开始读书有什么好处？',
    '开始念咒的角色是谁？',
    '不要开始念',
    '明天再开始念',
    '不要给我念一首诗',
    '明天给我念一首英文诗和一首中文诗',
    '解释念一首诗有什么技巧',
    '我想念一首诗',
    '她念两首诗',
    '我刚才读一篇文章',
    '帮我读 README 并检查编译错误',
    '把“给我念一首英文诗和一首中文诗”翻译成英文',
    '例如，给我念一首英文诗和一首中文诗',
    '朗读好听吗？',
    '请把“朗读这首词”翻译成英文',
    '翻译成英文：请朗读这首词',
    '他说朗读这首词',
    '例如，请朗读这首词',
    '“请朗读这首词”是什么意思？',
    '> 请朗读这首词\n分析这句话的语法。',
    '`请朗读这首词` 是输入示例。',
    '```text\n请朗读这首词\n```',
    "Translate 'read this aloud' into Chinese.",
    'Translate into Chinese: read this poem aloud.',
    'He said read this poem aloud.',
    '不要朗读这首词',
    '不用把这段读出来',
    '停止朗读',
    '关闭自动朗读',
    '请朗读这首词，但只用文字回复。',
    "Don't read this poem aloud.",
    'Read this poem aloud. Text only please.',
    '明天早上七点朗读这首词',
    '请每天朗读一首诗',
    '设置定时朗读这首词',
    '十分钟后读一遍这首诗',
    'Tomorrow morning read this poem aloud.',
    'Schedule a reminder to read this poem aloud.'
  ])('does not authorize immediate playback from %s', text => {
    expect(isExplicitReadAloudRequest(text)).toBe(false);
  });

  it.each([
    '请朗读这首词作为明天的提醒',
    'Read this poem aloud tomorrow morning.'
  ])('does not mistake timing after the action for immediate consent: %s', text => {
    expect(isExplicitReadAloudRequest(text)).toBe(false);
  });

  it('allows a separate direct request after a quoted example', () => {
    expect(isExplicitReadAloudRequest('“不要朗读”是输入示例。现在请朗读《虞美人》。')).toBe(true);
  });
});

describe('desktop speech capability instructions', () => {
  it('describes enabled desktop playback for typed requests without claiming playback success', () => {
    const instructions = desktopSpeechInstructions(true, false);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain('客户端已启用本地 TTS 朗读');
    expect(instructions[0]).toContain('文字输入同样可以请求朗读');
    expect(instructions[0]).toContain('普通文字提问只用文字回复，不自动进入语音模式');
    expect(instructions[0]).toContain('实际合成和播放由客户端完成');
    expect(instructions[0]).toContain('在收到实际播放结果前，不要宣称用户已经听到或播放已完成');
  });

  it('requests complete original content once without changing future automatic-reading consent', () => {
    const instructions = desktopSpeechInstructions(true, true);
    expect(instructions).toHaveLength(2);
    expect(instructions[1]).toContain('为本轮完整正文发起一次朗读');
    expect(instructions[1]).toContain('不改变后续自动朗读偏好');
    expect(instructions[1]).toContain('保留原文全部句子');
    expect(instructions[1]).toContain('先准备好全部音频再连续播放到全文结束');
    expect(instructions[1]).toContain('多首或多篇按请求顺序依次给出正文');
    expect(instructions[1]).toContain('不要用口语摘要替代');
    expect(instructions[1]).toContain('不添加断句标记、重音标记、SSML、朗读教程或能力免责声明');
  });

  it.each([false, true])('guides disabled speech to saving the enable preference for read request %s', readAloud => {
    const instructions = desktopSpeechInstructions(false, readAloud);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]).toContain('客户端具备本地 TTS 朗读功能');
    expect(instructions[0]).toContain('当前语音尚未启用');
    expect(instructions[0]).toContain('语音设置开启语音并保存');
    expect(instructions[0]).toContain('不需要先录音或完成试听测试');
    expect(instructions[0]).toContain('不要宣称已经播放');
    expect(instructions.join('\n')).not.toContain('为本轮完整正文发起一次朗读');
  });
});
