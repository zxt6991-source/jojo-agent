const chineseStop = new RegExp([
  '(?:不要|不用|不必|别|停止|停下|关闭|禁用|取消|暂停|不需要|不想要?|不允许|禁止)',
  '(?:(?:再|继续|直接|给我|帮我|替我|你|您|自己|擅自|自动|主动|默认|语音|使用|用|进行)',
  '|(?:把|将)(?:你[的]?|这次的?|所有的?)?(?:回复|回答|消息|文字|内容)){0,6}',
  '(?:朗读|阅读出来|读出来|念出来|读出声|念出声|出声|读|念|语音(?:回复|回答|播报)|(?:说|讲)出来)',
  '(?:(?:你|这次|所有)(?:的)?)?(?:回复|回答|消息|内容|文字|文本)?',
  '(?:了|啦|啊|吧|好吗|可以吗|谢谢|就好|就行)*$'
].join(''), 'u');
const chineseTextOnly = new RegExp([
  '(?:(?:只|仅|只要|只需|仅需)(?:(?:用|使用)?(?:文字|文本)(?:回复|回答|交流|沟通)?|(?:给(?:我)?|回复|回答|输出)(?:文字|文本))',
  '|(?:用)?(?:文字|文本)(?:回复|回答)(?:就好|就行|即可))(?:了|吧|谢谢)*$'
].join(''), 'u');
const englishAloudSuffix = String.raw`(?:\s+(?:it|this|that|your\s+(?:response|reply|replies)))?\s+(?:aloud|out\s+loud)`;
const englishStop = new RegExp([
  String.raw`\b(?:(?:do\s+not|don't|dont|never|no\s+need\s+to)\s+(?:(?:automatically|auto)\s+)?`,
  String.raw`(?:read${englishAloudSuffix}|speak(?:\s+(?:your\s+)?(?:responses?|replies))?`,
  String.raw`|(?:use|send|give)(?:\s+me)?\s+(?:voice|audio|spoken)\s+(?:responses?|replies))`,
  String.raw`|stop\s+(?:(?:automatically|auto)\s+)?`,
  `(?:reading${englishAloudSuffix}|speaking|talking)`,
  String.raw`|(?:disable|turn\s+off|stop)\s+(?:auto(?:matic)?\s+(?:reading|read(?:ing)?\s+aloud)`,
  String.raw`|(?:automatic\s+)?(?:spoken|voice|audio)\s+(?:responses?|replies)|tts))`,
  String.raw`(?:\s+(?:please|thanks|anymore|again|from\s+now\s+on))*$`
].join(''), 'iu');
const englishTextOnly = new RegExp([
  String.raw`\b(?:(?:reply|respond|answer)(?:\s+to\s+me)?\s+(?:in|with|using)\s+(?:plain\s+)?text\s+only`,
  String.raw`|only\s+(?:reply|respond|answer)(?:\s+to\s+me)?\s+(?:in|with|using)\s+(?:plain\s+)?text`,
  String.raw`|(?:only\s+text|text\s+only))(?:\s+(?:please|thanks))*$`
].join(''), 'iu');
const meta = /翻译|译成|怎么|如何|这句话|这句|那句话|那句|示例|例如|比如|意思|他说|她说|\b(?:translate|translation|what\s+does|how\s+(?:do|to)\b|for\s+example|he\s+said|she\s+said)\b/iu;
const exampleLead = /^(?:例如|比如|示例|举例(?:来说)?|for\s+example)\s*[:：]?$/iu;

function withoutQuotedExamples(text: string): string {
  return text.replace(/```[\s\S]*?(?:```|$)/gu, ' ')
    .replace(/`[^`\n]*`/gu, ' ')
    .replace(/“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\n]*"/gu, ' ')
    .replace(/(^|[\s([{：:])'[^'\n]+'(?=$|[\s)\]},.!?;:])/gu, '$1 ')
    .replace(/^\s*>.*$/gmu, ' ').replace(/’/gu, "'");
}

/** Match explicit requests to stop spoken replies. This changes no microphone,
 * manual playback or scheduled reminder preferences. */
export function shouldDisableAutoRead(text: string): boolean {
  const unquoted = withoutQuotedExamples(text);

  // Keeping the action and its modifiers adjacent avoids matching an unrelated
  // “不要” elsewhere in a sentence. Requiring the end of a clause also excludes
  // local restrictions such as “不要朗读代码” or “don't read the URL aloud”.
  for (const sentence of unquoted.split(/[。.!！?？\n]+/u)) {
    const clauses = sentence.split(/[，,；;]+/u);
    for (const [index, clause] of clauses.entries()) {
      const value = clause.trim();
      const match = chineseStop.exec(value) ?? chineseTextOnly.exec(value)
        ?? englishStop.exec(value) ?? englishTextOnly.exec(value);
      if (!match) continue;
      // Apply translation/example context locally. A separate translation task
      // must not swallow a later “只用文字回复” constraint in the same sentence.
      const before = value.slice(0, match.index);
      const previous = clauses[index - 1]?.trim() ?? '';
      if (!meta.test(before) && !exampleLead.test(previous)) return true;
    }
  }
  return false;
}

/** One-turn consent from the top-level user request, independent of the input
 * modality and the persistent automatic-reply preference. */
export function isExplicitReadAloudRequest(text: string): boolean {
  if (shouldDisableAutoRead(text)) return false;
  const unquoted = withoutQuotedExamples(text);
  const clauses = unquoted.split(/[。.!！?？\n，,；;]+/u);
  for (const [index, clause] of clauses.entries()) {
    if (exampleLead.test(clauses[index - 1]?.trim() ?? '')) continue;
    const action = /朗读|读出来|念出来|读给我听|念给我听|读出声|念出声|(?:给我|为我|帮我)(?:读|念)(?=\s*[《“「])|(?:开始|继续|接着)(?:读|念)(?=\s*(?:[了吧啊呀啦哦]*\s*$|[《“「]|(?:这|那)(?:首|段|篇)|一遍|一下|下去|给我听))|(?:读|念)(?:[一二两三四五六七八九十几\d]+\s*(?:首|篇|段)|一遍|一下|(?:这|那)(?:首|段|篇)|这个|吧\s*$)|\b(?:recite\b|read\b[^.!?\n]{0,300}\b(?:aloud|out\s+loud)\b)/iu.exec(clause);
    if (!action) continue;
    const before = clause.slice(0, action.index);
    const after = clause.slice(action.index + action[0].length);
    if (/^\s*(?:今天|昨天|刚才|现在)?(?:我|他|她|我们|他们|她们)(?:刚刚|刚才|已经|正在|准备|打算|决定|想|要|会)?\s*$/u.test(before)) continue;
    if (meta.test(before) || /(?:例如|比如|示例|他说|她说|用户说|用户要求|翻译|译成|意思是|explain|example|said|translation)/iu.test(before)) continue;
    if (/(?:解释|介绍|讨论|区别|比较|对比|为什么|什么是|是否|支持|喜欢|听说|功能|设置|按钮|(?:能不能|能否)实现|how\s+(?:is|does|can))/iu.test(before)) continue;
    if (/(?:不要|不用|别|不必|不需要|停止|取消|关闭|禁用|不想|do\s+not|don't|dont|never|stop|disable)[^。!?？]*$/iu.test(before)) continue;
    if (/^(?:功能|按钮|设置|的(?:功能|按钮|设置)|是什么意思|是怎么|如何|怎么)/u.test(after.trim())) continue;
    if (/(?:是什么|什么意思|有什么区别|的区别|的原理|的实现|好听吗|效果如何)/u.test(after)) continue;
    if (/(?:每天|每晚|每周|每隔|明天|后天|定时|提醒|分钟后|小时后|schedule|every\s+(?:day|week|hour)|tomorrow)/iu.test(clause)) continue;
    return true;
  }
  return false;
}

