/**
 * QIDS-J: 日本語版 自己記入式 簡易抑うつ症状尺度
 * Quick Inventory of Depressive Symptomatology (Japanese Version)
 * 出典: 厚生労働省 https://www.mhlw.go.jp/bunya/shougaihoken/kokoro/dl/02.pdf
 *
 * 採点方法:
 *  - 睡眠 (Q1-Q4): 最も高い点数 1つ
 *  - 食欲/体重 (Q6-Q9): 最も高い点数 1つ
 *  - 精神運動 (Q15-Q16): 最も高い点数 1つ
 *  - その他 (Q5, Q10, Q11, Q12, Q13, Q14): それぞれの点数
 *  - 合計 9 項目 (0-27点)
 */

const QUESTIONS = [
  {
    id: 1,
    domain: 'sleep',
    title: '寝つき',
    options: [
      '問題ない（または、寝付くのに30分以上かかったことは一度もない）',
      '寝つくのに30分以上かかったこともあるが、一週間の半分以下である',
      '寝つくのに30分以上かかったことが、週の半分以上ある',
      '寝つくのに60分以上かかったことが、（1週間の）半分以上ある'
    ]
  },
  {
    id: 2,
    domain: 'sleep',
    title: '夜間の睡眠',
    options: [
      '問題ない（夜間に目が覚めたことはない）',
      '落ち着かない、浅い眠りで、何回か短く目が覚めたことがある',
      '毎晩少なくとも1回は目が覚めるが、難なくまた眠ることができる',
      '毎晩1回以上目が覚め、そのまま20分以上眠れないことが、（1週間の）半分以上ある'
    ]
  },
  {
    id: 3,
    domain: 'sleep',
    title: '早く目が覚めすぎる',
    options: [
      '問題ない（または、ほとんどの場合、目が覚めるのは、起きなくてはいけない時間の、せいぜい30分前である）',
      '週の半分以上、起きなくてはならない時間より30分以上早く目が覚める',
      'ほとんどいつも、起きなくてはならない時間より1時間早く目が覚めてしまうが、最終的にはまた眠ることができる',
      '起きなくてはならない時間よりも1時間以上早く起きてしまい、もう一度眠ることができない'
    ]
  },
  {
    id: 4,
    domain: 'sleep',
    title: '眠りすぎる',
    options: [
      '問題ない（夜間、眠りすぎることはなく、日中に昼寝をすることもない）',
      '24時間のうち、眠っている時間は、昼寝を含めて10時間ほどである',
      '24時間のうち、眠っている時間は、昼寝を含めて12時間ほどである',
      '24時間のうち、昼寝を含めて12時間以上眠っている'
    ]
  },
  {
    id: 5,
    domain: 'mood',
    title: '悲しい気持ち',
    options: [
      '悲しいとは思わない',
      '悲しいと思うことは、半分以下の時間である',
      '悲しいと思うことが半分以上の時間ある',
      'ほとんどすべての時間、悲しいと感じている'
    ]
  },
  {
    id: 6,
    domain: 'appetite',
    title: '食欲低下',
    options: [
      '普段の食欲とかわらない、または、食欲が増えた',
      '普段よりいくぶん食べる回数が少ないか、量が少ない',
      '普段よりかなり食べる量が少なく、食べるよう努めないといけない',
      'まる1日（24時間）ほとんどものを食べず、食べるのは極めて強く食べようと努めたり、誰かに食べるよう説得されたときだけである'
    ]
  },
  {
    id: 7,
    domain: 'appetite',
    title: '食欲増進',
    options: [
      '普段の食欲とかわらない、または、食欲が減った',
      '普段より頻回に食べないといけないように感じる',
      '普段とくらべて、常に食べる回数が多かったり、量が多かったりする',
      '食事の時も、食事と食事の間も、食べ過ぎる衝動にかられている'
    ]
  },
  {
    id: 8,
    domain: 'appetite',
    title: '体重減少（最近2週間で）',
    options: [
      '体重は変わっていない、または、体重は増えた',
      '少し体重が減った気がする',
      '1キロ以上やせた',
      '2キロ以上やせた'
    ]
  },
  {
    id: 9,
    domain: 'appetite',
    title: '体重増加（最近2週間で）',
    options: [
      '体重は変わっていない、または、体重は減った',
      '少し体重が増えた気がする',
      '1キロ以上太った',
      '2キロ以上太った'
    ]
  },
  {
    id: 10,
    domain: 'concentration',
    title: '集中力／決断',
    options: [
      '集中力や決断力は普段とかわりない',
      'ときどき決断しづらくなっているように感じたり、注意が散漫になるように感じる',
      'ほとんどの時間、注意を集中したり、決断を下すのに苦労する',
      'ものを読むこともじゅうぶんにできなかったり、小さなことですら決断できないほど集中力が落ちている'
    ]
  },
  {
    id: 11,
    domain: 'self',
    title: '自分についての見方',
    options: [
      '自分のことを、他の人と同じくらい価値があって、援助に値する人間だと思う',
      '普段よりも自分を責めがちである',
      '自分が他の人に迷惑をかけているとかなり信じている',
      '自分の大小の欠陥について、ほとんど常に考えている'
    ]
  },
  {
    id: 12,
    domain: 'suicide',
    title: '死や自殺についての考え',
    options: [
      '死や自殺について考えることはない',
      '人生が空っぽに感じ、生きている価値があるかどうか疑問に思う',
      '自殺や死について、1週間に数回、数分間にわたって考えることがある',
      '自殺や死について1日に何回か細部にわたって考える、または、具体的な自殺の計画を立てたり、実際に死のうとしたりしたことがあった'
    ]
  },
  {
    id: 13,
    domain: 'interest',
    title: '一般的な興味',
    options: [
      '他人のことやいろいろな活動についての興味は普段と変わらない',
      '人々や活動について、普段より興味が薄れていると感じる',
      '以前好んでいた活動のうち、一つか二つのことにしか興味がなくなっていると感じる',
      '以前好んでいた活動に、ほとんどまったく興味がなくなっている'
    ]
  },
  {
    id: 14,
    domain: 'energy',
    title: 'エネルギーのレベル',
    options: [
      '普段のエネルギーのレベルと変わりない',
      '普段よりも疲れやすい',
      '普段の日常の活動（例えば、買い物、宿題、料理、出勤など）をやり始めたり、やりとげるのに、大きな努力が必要である',
      'ただエネルギーがないという理由だけで、日常の活動のほとんどが実行できない'
    ]
  },
  {
    id: 15,
    domain: 'psychomotor',
    title: '動きが遅くなった気がする',
    options: [
      '普段どおりの速さで考えたり、話したり、動いたりしている',
      '頭の働きが遅くなっていたり、声が単調で平坦に感じる',
      'ほとんどの質問に答えるのに何秒かかかり、考えが遅くなっているのがわかる',
      '最大の努力をしないと、質問に答えられないことがしばしばである'
    ]
  },
  {
    id: 16,
    domain: 'psychomotor',
    title: '落ち着かない',
    options: [
      '落ち着かない気持ちはない',
      'しばしばそわそわしていて、手をもんだり、座り直したりせずにはいられない',
      '動き回りたい衝動があって、かなり落ち着かない',
      'ときどき、座っていられなくて歩き回らずにはいられないことがある'
    ]
  }
];

/**
 * QIDS-J 採点計算 (9項目合計, 0-27点)
 * @param {number[]} answers 16項目の回答 (0-3)
 * @returns {{ total:number, severity:string, severityKey:string, breakdown:object }}
 */
function calculateScore(answers) {
  const max = (indices) => Math.max(...indices.map(i => answers[i] ?? 0));

  const sleep        = max([0, 1, 2, 3]);     // Q1-Q4
  const sad          = answers[4] ?? 0;        // Q5
  const appetite     = max([5, 6, 7, 8]);     // Q6-Q9
  const concentration= answers[9] ?? 0;        // Q10
  const self         = answers[10] ?? 0;       // Q11
  const suicide      = answers[11] ?? 0;       // Q12
  const interest     = answers[12] ?? 0;       // Q13
  const energy       = answers[13] ?? 0;       // Q14
  const psychomotor  = max([14, 15]);          // Q15-Q16

  const total = sleep + sad + appetite + concentration + self + suicide + interest + energy + psychomotor;

  let severity, severityKey;
  if (total <= 5)       { severity = '正常';          severityKey = 'normal';   }
  else if (total <= 10) { severity = '軽度';          severityKey = 'mild';     }
  else if (total <= 15) { severity = '中等度';        severityKey = 'moderate'; }
  else if (total <= 20) { severity = '重度';          severityKey = 'severe';   }
  else                  { severity = 'きわめて重度';  severityKey = 'extreme';  }

  return {
    total,
    severity,
    severityKey,
    breakdown: { sleep, sad, appetite, concentration, self, suicide, interest, energy, psychomotor }
  };
}
