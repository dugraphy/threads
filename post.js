require('dotenv').config();
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');

const REPO_PATH = __dirname;
const POSTS_DIR = path.join(REPO_PATH, 'content', 'posts');
const SCRIPT_PATH = path.join(REPO_PATH, 'post.js');
const TOKEN = process.env.THREADS_ACCESS_TOKEN;
const USER_ID = process.env.THREADS_USER_ID;

// GitHub 저장소 정보 (raw 이미지 URL 생성용)
const GITHUB_USER = 'dugraphy';
const GITHUB_REPO = 'threads';
const GITHUB_BRANCH = 'main';

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

// 파일 내용을 메타데이터 + 본문(+ 댓글)으로 분리
function parsePost(content) {
  const [metaRaw, ...bodyParts] = content.split('---');
  const fullBody = bodyParts.join('---').trim();

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

function checkLength(text, label) {
  if (text.length > 500) {
    throw new Error(`${label} 글자수 초과 (${text.length}자, 최대 500자)`);
  }
}

// IMAGE 필드 값(예: images/loading-speed.jpg)을 GitHub raw URL로 변환
function toImageUrl(imagePath) {
  if (!imagePath) return null;
  // content/ 기준 상대경로라고 가정 (content/images/xxx.jpg)
  const cleanPath = imagePath.replace(/^\/+/, '');
  return `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/${GITHUB_BRANCH}/content/${cleanPath}`;
}

// 텍스트 전용 발행
async function createAndPublish(text, replyToId = null) {
  let createUrl = `https://graph.threads.net/v1.0/${USER_ID}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&access_token=${TOKEN}`;
  if (replyToId) {
    createUrl += `&reply_to_id=${replyToId}`;
  }

  const createRes = await httpsPost(createUrl);
  if (!createRes.id) {
    return { success: false, error: createRes };
  }

  const publishUrl = `https://graph.threads.net/v1.0/${USER_ID}/threads_publish?creation_id=${createRes.id}&access_token=${TOKEN}`;
  const publishRes = await httpsPost(publishUrl);

  if (!publishRes.id) {
    return { success: false, error: publishRes };
  }

  return { success: true, id: publishRes.id };
}

// 이미지 + 텍스트 발행
async function createAndPublishWithImage(text, imageUrl, replyToId = null) {
  let createUrl = `https://graph.threads.net/v1.0/${USER_ID}/threads?media_type=IMAGE&image_url=${encodeURIComponent(imageUrl)}&text=${encodeURIComponent(text)}&access_token=${TOKEN}`;
  if (replyToId) {
    createUrl += `&reply_to_id=${replyToId}`;
  }

  const createRes = await httpsPost(createUrl);
  if (!createRes.id) {
    return { success: false, error: createRes };
  }

  // 이미지 처리는 시간이 걸릴 수 있어서, publish 전에 상태 확인 겸 잠시 대기
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const publishUrl = `https://graph.threads.net/v1.0/${USER_ID}/threads_publish?creation_id=${createRes.id}&access_token=${TOKEN}`;
  const publishRes = await httpsPost(publishUrl);

  if (!publishRes.id) {
    return { success: false, error: publishRes };
  }

  return { success: true, id: publishRes.id };
}

async function main() {
  console.log(`[${new Date().toISOString()}] 발행 스크립트 시작`);

  const beforeHash = fs.readFileSync(SCRIPT_PATH, 'utf-8');

  try {
    execSync(`git -C "${REPO_PATH}" pull origin main`, { stdio: 'inherit' });
  } catch (e) {
    console.error('git pull 실패:', e.message);
    return;
  }

  const afterHash = fs.readFileSync(SCRIPT_PATH, 'utf-8');

  if (beforeHash !== afterHash) {
    console.log('post.js가 업데이트되었습니다. 새 버전으로 재실행합니다.');
    const child = spawn('node', [SCRIPT_PATH], {
      cwd: REPO_PATH,
      stdio: 'inherit',
      detached: true,
    });
    child.unref();
    return;
  }

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

  const { meta, body, comment } = parsePost(target.content);

  try {
    checkLength(body, '원글');
    if (comment) checkLength(comment, '댓글');
  } catch (e) {
    console.error('발행 취소:', e.message);
    console.log('STATUS는 "대기"로 유지됩니다. 파일을 수정한 후 다시 시도하세요.');
    return;
  }

  // IMAGE 필드 확인
  const imageUrl = meta.IMAGE && meta.IMAGE.trim() ? toImageUrl(meta.IMAGE.trim()) : null;

  let mainResult;
  if (imageUrl) {
    console.log(`이미지 포함 발행: ${imageUrl}`);
    mainResult = await createAndPublishWithImage(body, imageUrl);
  } else {
    mainResult = await createAndPublish(body);
  }

  if (!mainResult.success) {
    console.error('원글 발행 실패:', JSON.stringify(mainResult.error));
    console.log('STATUS는 "대기"로 유지됩니다. 다음 실행 때 재시도됩니다.');
    return;
  }

  console.log(`원글 발행 성공! 스레드 ID: ${mainResult.id}`);

  if (comment) {
    const commentResult = await createAndPublish(comment, mainResult.id);
    if (commentResult.success) {
      console.log(`댓글 발행 성공! 댓글 ID: ${commentResult.id}`);
    } else {
      console.error('댓글 발행 실패:', JSON.stringify(commentResult.error));
      console.log('원글은 발행됐지만 댓글은 실패했습니다.');
    }
  }

  const updated = target.content.replace('STATUS: 대기', 'STATUS: 발행완료');
  fs.writeFileSync(target.filePath, updated, 'utf-8');

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