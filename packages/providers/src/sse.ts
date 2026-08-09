function dataValue(line: string): string {
  const value = line.slice('data:'.length);
  return value.startsWith(' ') ? value.slice(1) : value;
}

export async function* readSseData(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventData: string[] = [];
  let fullyRead = false;

  function consumeLine(rawLine: string): string | undefined {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      if (eventData.length === 0) return undefined;
      const data = eventData.join('\n');
      eventData = [];
      return data;
    }
    if (line.startsWith('data:')) eventData.push(dataValue(line));
    return undefined;
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        fullyRead = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        const data = consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (data !== undefined) yield data;
        newline = buffer.indexOf('\n');
      }
    }

    buffer += decoder.decode();
    if (buffer.length > 0) {
      const data = consumeLine(buffer);
      if (data !== undefined) yield data;
    }
    if (eventData.length > 0) yield eventData.join('\n');
  } finally {
    if (!fullyRead) {
      try {
        await reader.cancel();
      } catch {
        // The originating request may already have aborted the stream.
      }
    }
    reader.releaseLock();
  }
}
