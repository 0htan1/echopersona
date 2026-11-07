import crypto from 'node:crypto';

/** Demo dataset used by "体验示例解析" — no network, no API key needed. */
export function sampleTxt() {
  return `2024-03-12 21:04:33 林小满
今天下班又是十点半，地铁上人还是好多。

2024-03-12 21:05:02 我
又加班？你们组是不要人活了吧

2024-03-12 21:05:41 林小满
害，习惯了，反正回去也是一个人待着。
你呢，今天吃得还行吗

2024-03-12 21:06:15 我
凑合吧 楼下那家面馆

2024-03-12 21:06:44 林小满
那家我记得，汤太咸了哈哈哈
下次我带你去吃一家特别好吃的，就我上次说的那个巷子里的

2024-03-12 21:07:10 我
你还记着啊

2024-03-12 21:07:39 林小满
记得啊，我说过的话基本都记得的。
你别老是不当真嘛

2024-03-13 09:12:20 林小满
早呀，今天天气好好，晒被子了

2024-03-13 09:30:05 我
我也起了 今天要开一天会

2024-03-13 09:30:44 林小满
那你中午记得吃饭，别又饿到下午
开会的时候偷偷回我消息也行，我不急的哈哈哈

2024-04-02 23:11:09 林小满
有点烦，不太想说话
但是又想说给你听

2024-04-02 23:13:22 我
怎么了

2024-04-02 23:14:01 林小满
就是那种，明明什么都没发生，但是突然就觉得没意思
算了 说出来我自己都觉得矫情

2024-04-02 23:15:30 我
不矫情 你说

2024-04-02 23:16:02 林小满
你每次都这样 我就更想说了
谢谢你啊，真的`;
}

export function sampleJson() {
  return JSON.stringify({
    conversation: 'demo',
    participants: ['林小满', '我'],
    messages: [
      { sender: '林小满', timestamp: 1710248673000, content: '今天下班又是十点半，地铁上人还是好多。' },
      { sender: '我', timestamp: 1710248702000, content: '又加班？你们组是不要人活了吧' },
      { sender: '林小满', timestamp: 1710248741000, content: '害，习惯了，反正回去也是一个人待着。你呢，今天吃得还行吗' },
      { sender: '我', timestamp: 1710248775000, content: '凑合吧 楼下那家面馆' },
      { sender: '林小满', timestamp: 1710248804000, content: '那家我记得，汤太咸了哈哈哈。下次我带你去吃一家特别好吃的。' },
      { sender: '我', timestamp: 1710248830000, content: '你还记着啊' },
      { sender: '林小满', timestamp: 1710248859000, content: '记得啊，我说过的话基本都记得的。你别老是不当真嘛' },
      { sender: '林小满', timestamp: 1710292340000, content: '早呀，今天天气好好，晒被子了' },
      { sender: '我', timestamp: 1710293405000, content: '我也起了 今天要开一天会' },
      { sender: '林小满', timestamp: 1710293444000, content: '那你中午记得吃饭，别又饿到下午。开会的时候偷偷回我消息也行，我不急的哈哈哈' },
    ],
  }, null, 2);
}

export function sampleCsv() {
  return `sender,timestamp,content,type
林小满,2024-04-02 23:11:09,有点烦，不太想说话,text
我,2024-04-02 23:13:22,怎么了,text
林小满,2024-04-02 23:14:01,就是那种 明明什么都没发生 但是突然就觉得没意思,text
我,2024-04-02 23:15:30,不矫情 你说,text
林小满,2024-04-02 23:16:02,你每次都这样 我就更想说了,text`;
}

export function sampleMd() {
  return `# 与林小满的聊天

**林小满**: 今天下班又是十点半，地铁上人还是好多。
**我**: 又加班？你们组是不要人活了吧
**林小满**: 害，习惯了，反正回去也是一个人待着。你呢，今天吃得还行吗
**我**: 凑合吧 楼下那家面馆
**林小满**: 那家我记得，汤太咸了哈哈哈
**我**: 你还记着啊
**林小满**: 记得啊，我说过的话基本都记得的。你别老是不当真嘛`;
}

/** A tiny valid ZIP containing two TXT entries — used by the parser self-test. */
export function buildSampleZip(entries) {
  const files = entries.map((e) => ({ name: e.name, data: Buffer.from(e.content, 'utf8') }));
  return buildZip(files);
}

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** Minimal STORE-only ZIP writer (no dependencies). */
export function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = f.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(0, 8);      // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, end]);
}
