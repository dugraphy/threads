require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_PATH = __dirname;
const POSTS_DIR = path.join(REPO_PATH, 'content', 'posts');
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const USER_ID = process.env.THREADS_USER_ID;

// 간단한 HTTPS POST 요청 헬퍼
function httpsPost(url) {
  return new Promise((resolve, reject) => {
    https.request(url, { method: 'POST' }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('응답 파싱 실패: ' + data));
        }
      });
    }).on('error', reject).end();
  });
}

// 파일 내용을 메타데이터 + 본문으로 분리
function parsePost(content) {
  const [metaRaw, ...bodyParts] = content.split('---');
  const body = bodyParts.join('---').trim();
  const meta = {};
  metaRaw.split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  });
  return { meta, body };
}

async function postToThreads(text) {
  // 1단계: Container 생성
  const createUrl = `https://graph.threads.net/v1.0/${USER_ID}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&access_token=${TOKEN}`;
  const createRes = await httpsPost(createUrl);

  if (!createRes.id) {
    return { success: false, error: createRes };
  }

  // 2단계: Publish
  const publishUrl = `https://graph.threads.net/v1.0/${USER_ID}/threads_publish?creation_id=${createRes.id}&access_token=${TOKEN}`;
  const publishRes = await httpsPost(publishUrl);

  if (!publishRes.id) {
    return { success: false, error: publishRes };
  }

  return { success: true, id: publishRes.id };
}

async function main() {
  console.log(`[${new Date().toISOString()}] 발행 스크립트 시작`);

  // 1. 최신 콘텐츠 받아오기
  try {
    execSync(`git -C "${REPO_PATH}" pull origin main`, { stdio: 'inherit' });
  } catch (e) {
    console.error('git pull 실패:', e.message);
    return;
  }

  // 2. 대기 중인 글 찾기 (파일명 순 = 날짜순)
  const files = fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith('.txt')).sort();

  let target = null;
  for (const file of files) {
    const filePath = path.join(POSTS_DIR, file);
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.includes('STATUS: 대기')) {
      target = { file, filePath, content };
      break;
    }
  }

  if (!target) {
    console.log('발행할 대기 중인 글이 없습니다.');
    return;
  }

  console.log(`발행 대상: ${target.file}`);

  // 3. 파싱
  const { body } = parsePost(target.content);

  // 4. 발행
  const result = await postToThreads(body);

  if (result.success) {
    console.log(`발행 성공! 스레드 ID: ${result.id}`);

    // 5. STATUS 변경
    const updated = target.content.replace('STATUS: 대기', 'STATUS: 발행완료');
    fs.writeFileSync(target.filePath, updated, 'utf-8');

    // 6. git commit & push
    try {
      execSync(`git -C "${REPO_PATH}" add .`);
      execSync(`git -C "${REPO_PATH}" commit -m "발행완료: ${target.file}"`);
      execSync(`git -C "${REPO_PATH}" push origin main`, { stdio: 'inherit' });
      console.log('GitHub에 반영 완료');
    } catch (e) {
      console.error('git commit/push 실패:', e.message);
    }
  } else {
    console.error('발행 실패:', JSON.stringify(result.error));
    console.log('STATUS는 "대기"로 유지됩니다. 다음 실행 때 재시도됩니다.');
  }
}

main();