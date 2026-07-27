require('dotenv').config();
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_PATH = __dirname;
const POSTS_DIR = path.join(REPO_PATH, 'content', 'posts');
const SCRIPT_PATH = path.join(REPO_PATH, 'post.js');
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const USER_ID = process.env.THREADS_USER_ID;
const PM2_PROCESS_NAME = '스레드자동발행'; // pm2로 등록한 프로세스 이름과 반드시 일치해야 함

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

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('응답 파싱 실패: ' + data));
        }
      });
    }).on('error', reject);
  });
}

// 파일 내용을 메타데이터 + 본문(+ 댓글)으로 분리
function parsePost(content) {
  const [metaRaw, ...bodyParts] = content.split('---');
  const fullBody = bodyParts.join('---').trim();

  // ===COMMENT=== 기준으로 원글/댓글 분리
  const [mainBody, ...commentParts] = fullBody.split('===COMMENT===');
  const comment = commentParts.length > 0 ? commentParts.join('===COMMENT===').trim() : null;

  const meta = {};
  metaRaw.split('\n').forEach((line) => {
    const idx = line.indexOf(':');
    if (idx === -1) return;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) meta[key] = value;
  });

  return { meta, body: mainBody.trim(), comment };
}

// 글자수 체크 (500자 제한)
function checkLength(text, label) {
  if (text.length > 500) {
    throw new Error(`${label} 글자수 초과 (${text.length}자, 최대 500자)`);
  }
}

async function createAndPublish(text, replyToId = null) {
  // 1단계: Container 생성
  let createUrl = `https://graph.threads.net/v1.0/${USER_ID}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&access_token=${TOKEN}`;
  if (replyToId) {
    createUrl += `&reply_to_id=${replyToId}`;
  }

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

// 원글이 실제로 조회 가능한 상태가 될 때까지 확인 후 재시도
// (색인 지연으로 인한 "미디어를 찾을 수 없음" 에러 방지)
async function waitUntilAvailable(threadId, maxRetries = 6, intervalMs = 5000) {
  const checkUrl = `https://graph.threads.net/v1.0/${threadId}?fields=id&access_token=${TOKEN}`;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await httpsGet(checkUrl);
      if (res.id === threadId) {
        console.log(`원글 조회 확인 완료 (시도 ${i + 1}/${maxRetries})`);
        return true;
      }
    } catch (e) {
      // 조회 실패하면 아래에서 대기 후 재시도
    }
    console.log(`원글이 아직 조회되지 않음. ${intervalMs / 1000}초 후 재시도 (${i + 1}/${maxRetries})`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

async function main() {
  console.log(`[${new Date().toISOString()}] 발행 스크립트 시작`);

  // 0. 실행 시작 시점의 post.js 내용 기록 (나중에 변경 여부 비교용)
  const beforeHash = fs.readFileSync(SCRIPT_PATH, 'utf-8');

  // 1. 최신 콘텐츠/코드 받아오기
  try {
    execSync(`git -C "${REPO_PATH}" pull origin main`, { stdio: 'inherit' });
  } catch (e) {
    console.error('git pull 실패:', e.message);
    return;
  }

  // 2. pull 이후 post.js 자체가 바뀌었는지 확인
  const afterHash = fs.readFileSync(SCRIPT_PATH, 'utf-8');

  if (beforeHash !== afterHash) {
    console.log('post.js가 업데이트되었습니다. pm2를 통해 안전하게 재시작합니다.');
    try {
      // spawn/detached 대신 pm2 restart 사용:
      // - 기존 프로세스가 완전히 종료된 후 새 버전이 시작되므로
      //   같은 파일을 두 프로세스가 동시에 처리하는 문제(중복 발행/댓글 ID 뒤섞임)를 방지함
      execSync(`pm2 restart ${PM2_PROCESS_NAME}`, { stdio: 'inherit' });
    } catch (e) {
      console.error('pm2 restart 실패:', e.message);
    }
    return; // 지금(구버전) 실행은 여기서 조용히 종료, 발행 시도 안 함
  }

  // 3. 대기 중인 글 찾기 (파일명 순 = 날짜순)
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

  // 4. 파싱
  const { body, comment } = parsePost(target.content);

  // 5. 글자수 사전 체크
  try {
    checkLength(body, '원글');
    if (comment) checkLength(comment, '댓글');
  } catch (e) {
    console.error('발행 취소:', e.message);
    console.log('STATUS는 "대기"로 유지됩니다. 파일을 수정한 후 다시 시도하세요.');
    return;
  }

  // 6. 원글 발행
  const mainResult = await createAndPublish(body);

  if (!mainResult.success) {
    console.error('원글 발행 실패:', JSON.stringify(mainResult.error));
    console.log('STATUS는 "대기"로 유지됩니다. 다음 실행 때 재시도됩니다.');
    return;
  }

  console.log(`원글 발행 성공! 스레드 ID: ${mainResult.id}`);

  // 7. 댓글이 있으면 원글에 이어서 발행
  //    -> 원글이 실제로 조회 가능한 상태가 될 때까지 확인 후 시도 (색인 지연 대응)
  let commentStatusNote = '';
  if (comment) {
    const isAvailable = await waitUntilAvailable(mainResult.id);

    if (!isAvailable) {
      console.error('원글 조회 확인 실패 (시간 초과). 댓글 발행을 시도하지 않습니다.');
      commentStatusNote = ' (댓글 대기 시간 초과, 수동으로 추가 필요)';
    } else {
      const commentResult = await createAndPublish(comment, mainResult.id);
      if (commentResult.success) {
        console.log(`댓글 발행 성공! 댓글 ID: ${commentResult.id}`);
      } else {
        console.error('댓글 발행 실패:', JSON.stringify(commentResult.error));
        console.log('원글은 발행됐지만 댓글은 실패했습니다. STATUS는 발행완료로 처리하고, 댓글은 수동으로 다시 달아주세요.');
        commentStatusNote = ' (댓글 실패, 수동으로 추가 필요)';
      }
    }
  }

  // 8. STATUS 변경 (원글 성공 기준으로 발행완료 처리)
  const updated = target.content.replace('STATUS: 대기', `STATUS: 발행완료${commentStatusNote}`);
  fs.writeFileSync(target.filePath, updated, 'utf-8');

  // 9. git commit & push
  try {
    execSync(`git -C "${REPO_PATH}" add .`);
    execSync(`git -C "${REPO_PATH}" commit -m "발행완료: ${target.file}"`);
    execSync(`git -C "${REPO_PATH}" push origin main`, { stdio: 'inherit' });
    console.log('GitHub에 반영 완료');
  } catch (e) {
    console.error('git commit/push 실패:', e.message);
  }
}

main();