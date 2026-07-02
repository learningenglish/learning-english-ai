
// ====== KẾT NỐI CLOUDFLARE WORKER (thay cho việc gọi OpenAI trực tiếp + lưu API key) ======
// Đổi URL này thành URL Worker thật của bạn sau khi deploy (lệnh `wrangler deploy` sẽ in ra).
const WORKER_URL = "https://learning-english-ai-vercel.vercel.app/api/chat";

// Phải GIỐNG HỆT giá trị bạn đặt bằng `wrangler secret put APP_SECRET`.
// Đây không phải xác thực thật (frontend tĩnh thì vẫn đọc được qua DevTools nếu cố tình tìm),
// chỉ chặn được bot/script quét URL ngẫu nhiên trên Internet.
const APP_SECRET = "Learning-English-AI";

/**
 * Gọi 1 action trên Worker. Worker tự ráp prompt và gọi OpenAI — frontend chỉ gửi
 * dữ liệu thô (câu, từ, level...), KHÔNG bao giờ thấy prompt hay API key thật.
 * @param {string} action - tên action (xem danh sách trong worker.js: analyze_sentence, word_tip, ...)
 * @param {object} data   - tham số cho action đó
 * @returns {Promise<string|null>} nội dung trả lời (string), null nếu lỗi
 */
// Set bởi callWorker khi Server chặn vì hết credit tầng Student (403) — callAI đọc
// biến này ngay sau callWorker() để phân biệt "bị chặn có lý do" với "lỗi mạng thật".
let lastBlockMessage = null;
async function callWorker(action, data) {
  try {
    const headers = {
      "Content-Type": "application/json",
      "X-App-Secret": APP_SECRET,
    };
    // Chỉ gắn token khi đang đăng nhập Student — Server (chat.js) dùng token này để
    // tra đúng gói (Free/Basic/Pro) và trừ credit atomic trước khi gọi OpenAI. Mentor
    // không gắn header này nên hệ thống credit hiện có của Mentor không bị ảnh hưởng.
    if (currentStudent) {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) headers["X-Student-Token"] = session.access_token;
    }
    const r = await fetch(WORKER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ action, ...data }),
    });
    const result = await r.json();
    if (!r.ok || result.error) {
      console.error("Worker error:", result.error);
      lastBlockMessage = r.status === 403 ? result.error : null;
      return null;
    }
    lastBlockMessage = null;
    return result.content;
  } catch (e) {
    console.error("Network error calling worker:", e);
    lastBlockMessage = null;
    return null;
  }
}

// ====== SUPABASE (Auth + hồ sơ Mentor) ======
// Lấy 2 giá trị này trong Supabase Dashboard > Project Settings > API
const SUPABASE_URL = "https://ijwttrlxsmgaqxszphlp.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_D6NUatDu3ZapsLRwjKiBJw_Uh0ku3An";

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentMentor = null; // hồ sơ public.mentors của người đang đăng nhập, null nếu chưa đăng nhập
let authMode = "login"; // "login" | "register", đang chọn trong authModal

async function loadCurrentMentor(userId) {
  const { data, error } = await supabase.from("mentors").select("*").eq("id", userId).single();
  if (error) { console.error("loadCurrentMentor error:", error); return null; }
  return data;
}

// currentMentor là biến cache — nếu tab để lâu / token vừa refresh, nó có thể
// tạm thời chưa kịp cập nhật dù phiên đăng nhập vẫn còn hiệu lực. Trước khi
// CHẶN một hành động (báo "vui lòng đăng nhập"), luôn xác minh lại session
// thật qua Supabase để tránh báo sai khi thực ra vẫn đang đăng nhập.
async function ensureMentorSession() {
  if (currentMentor) return currentMentor;
  const { data: { session } } = await supabase.auth.getSession();
  if (session) currentMentor = await loadCurrentMentor(session.user.id);
  return currentMentor;
}

// ====== Cache mentor_folders (nạp lại sau khi login/tạo/sửa/xoá folder) ======
let mentorFolders = [];

async function loadMentorFolders() {
  if (!currentMentor) { mentorFolders = []; return; }
  const { data, error } = await supabase.from("mentor_folders").select("*").eq("mentor_id", currentMentor.id);
  if (error) { console.error("loadMentorFolders error:", error); return; }
  mentorFolders = data || [];
}
function getDefaultFolderId(level) {
  const f = mentorFolders.find(x => x.level === level && x.folder_type === "content" && x.is_auto);
  return f ? f.id : null;
}
function getReviewFolderId(level) {
  const f = mentorFolders.find(x => x.level === level && x.folder_type === "review" && x.is_auto);
  return f ? f.id : null;
}
async function getOrCreateExamSubFolder(contentFolderId) {
  const existing = mentorFolders.find(f => f.parent_folder_id === contentFolderId && f.folder_type === "exam_sub");
  if (existing) return existing.id;
  const parent = mentorFolders.find(f => f.id === contentFolderId);
  const { data, error } = await supabase.from("mentor_folders").insert({
    mentor_id: currentMentor.id, name: "Đề kiểm tra", level: parent ? parent.level : "A1-A2",
    folder_type: "exam_sub", is_auto: true, parent_folder_id: contentFolderId,
  }).select().single();
  if (error) { console.error("getOrCreateExamSubFolder error:", error); return null; }
  mentorFolders.push(data);
  return data.id;
}

// ====== Cache mentor_exams (nạp lại sau khi login/tạo/xoá đề) ======
let mentorExams = [];
async function loadMentorExams() {
  if (!currentMentor) { mentorExams = []; return; }
  const { data, error } = await supabase.from("mentor_exams").select("*").eq("mentor_id", currentMentor.id).order("created_at", { ascending: false });
  if (error) { console.error("loadMentorExams error:", error); return; }
  mentorExams = data || [];
}

// ====== Roster (mentor_students) + Chia sẻ (mentor_shares) ======
let mentorRoster = []; // [{student_id, email, full_name, added_at}]
let mentorShares = []; // toàn bộ share hiện có của mentor, để biết mục nào đã share cho ai

async function loadMentorRoster() {
  if (!currentMentor) { mentorRoster = []; return; }
  const { data, error } = await supabase.rpc("get_my_roster");
  if (error) { console.error("loadMentorRoster error:", error); return; }
  mentorRoster = data || [];
}
async function loadMentorShares() {
  if (!currentMentor) { mentorShares = []; return; }
  const { data, error } = await supabase.from("mentor_shares").select("*").eq("mentor_id", currentMentor.id);
  if (error) { console.error("loadMentorShares error:", error); return; }
  mentorShares = data || [];
}

async function addToRoster() {
  const input = document.getElementById("rosterEmailInput");
  const email = input.value.trim();
  if (!email) return;
  if (!(await ensureMentorSession())) { alert("Vui lòng đăng nhập."); return; }
  const { data: found, error: rpcErr } = await supabase.rpc("find_student_by_email", { p_email: email });
  if (rpcErr) { alert("Lỗi tra cứu: " + rpcErr.message); return; }
  if (!found || !found.length) {
    alert(`Email "${email}" chưa đăng ký tài khoản Student. Hãy nhắc học viên tạo tài khoản (chọn vai trò Student) trước.`);
    return;
  }
  const student = found[0];
  const { error: insErr } = await supabase.from("mentor_students").insert({
    mentor_id: currentMentor.id, student_id: student.id,
  });
  if (insErr) {
    if (insErr.code === "23505") alert("Học viên này đã có trong danh sách của bạn.");
    else alert("Lỗi thêm học viên: " + insErr.message);
    return;
  }
  input.value = "";
  await loadMentorRoster();
  loadRosterPanel();
}

async function removeFromRoster(studentId) {
  if (!confirm("Xoá học viên này khỏi danh sách? (không xoá tài khoản của họ)")) return;
  const { error } = await supabase.from("mentor_students").delete().eq("mentor_id", currentMentor.id).eq("student_id", studentId);
  if (error) { alert("Lỗi xoá: " + error.message); return; }
  mentorRoster = mentorRoster.filter(r => r.student_id !== studentId);
  loadRosterPanel();
}

function loadRosterPanel() {
  const el = document.getElementById("rosterContent");
  if (!el) return;
  if (!mentorRoster.length) {
    el.innerHTML = '<div style="color:#aaa;font-size:13px;padding:8px">Chưa có học viên nào. Thêm bằng email đã đăng ký ở trên.</div>';
    return;
  }
  el.innerHTML = mentorRoster.map(r => `
    <div class="hist-item">
      <div style="flex:1;min-width:0">
        <div class="hist-text">${r.full_name || r.email}</div>
        <div style="font-size:10px;color:#aaa;margin-top:1px">${r.email}</div>
      </div>
      <div class="hist-actions">
        <button class="hist-btn" onclick="openStudentProfile('${r.student_id}')" title="Xem hồ sơ">👁</button>
        <button class="hist-btn" onclick="removeFromRoster('${r.student_id}')" title="Xoá khỏi danh sách" style="color:#dc3545">🗑</button>
      </div>
    </div>`).join("");
}
function closeInfoModal() { document.getElementById("infoModal").classList.remove("open"); }

async function openStudentProfile(studentId) {
  const student = mentorRoster.find(r => r.student_id === studentId);
  if (!student) return;
  document.getElementById("infoModalTitle").textContent = "👤 " + (student.full_name || student.email);
  document.getElementById("infoModalBody").innerHTML = '<div style="padding:20px;text-align:center;color:#888">Đang tải...</div>';
  document.getElementById("infoModal").classList.add("open");

  const sharedExamIds = mentorShares.filter(s => s.student_id === studentId && s.item_type === "exam").map(s => s.item_id);
  const [{ data: submissions }, { data: activityRows }, { count: viewedCount }, { data: listenRows }] = await Promise.all([
    supabase.from("student_exam_submissions").select("*").eq("student_id", studentId),
    supabase.rpc("get_roster_activity"),
    supabase.from("user_viewed_words").select("*", { count: "exact", head: true }).eq("user_id", studentId),
    supabase.from("user_listen_stats").select("listen_count,total_seconds").eq("user_id", studentId),
  ]);

  const activity = (activityRows || []).find(a => a.student_id === studentId);
  const subsByExam = {};
  (submissions || []).forEach(s => { (subsByExam[s.exam_id] = subsByExam[s.exam_id] || []).push(s); });

  const examList = sharedExamIds.map(examId => {
    const exam = mentorExams.find(e => e.id === examId);
    const subs = subsByExam[examId] || [];
    const best = subs.length ? Math.max(...subs.map(s => s.score || 0)) : null;
    const latest = subs.length ? subs.slice().sort((a, b) => new Date(b.submitted_at) - new Date(a.submitted_at))[0] : null;
    const attemptsSorted = subs.slice().sort((a, b) => (a.attempt_number || 0) - (b.attempt_number || 0));
    return { title: exam ? exam.title : "(đề đã bị xoá)", best, latestScore: latest ? latest.score : null, breakdown: latest ? latest.breakdown : null, attempts: subs.length, attemptsSorted };
  });

  const doneCount = examList.filter(e => e.attempts > 0).length;
  const pendingCount = examList.length - doneCount;
  const bestScores = examList.filter(e => e.best != null).map(e => e.best);
  const overallBest = bestScores.length ? Math.max(...bestScores) : null;
  const totalListenCount = (listenRows || []).reduce((a, r) => a + (r.listen_count || 0), 0);
  const totalListenSec = (listenRows || []).reduce((a, r) => a + (r.total_seconds || 0), 0);

  document.getElementById("infoModalBody").innerHTML = `
    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:6px">Tổng quan</div>
      <div class="stat-row"><span class="stat-label">Đã hoàn thành</span><span class="stat-value">${doneCount} đề</span></div>
      <div class="stat-row"><span class="stat-label">Chưa hoàn thành</span><span class="stat-value">${pendingCount} đề</span></div>
      <div class="stat-row"><span class="stat-label">Điểm cao nhất chung</span><span class="stat-value">${overallBest != null ? overallBest + "%" : "—"}</span></div>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:12px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:6px">Mức độ sử dụng</div>
      <div class="stat-row"><span class="stat-label">Đăng nhập gần nhất</span><span class="stat-value">${activity && activity.last_sign_in_at ? new Date(activity.last_sign_in_at).toLocaleString("vi-VN") : "—"}</span></div>
      <div class="stat-row"><span class="stat-label">Từ đã tra</span><span class="stat-value">${viewedCount || 0}</span></div>
      <div class="stat-row"><span class="stat-label">Câu đã nghe</span><span class="stat-value">${totalListenCount}</span></div>
      <div class="stat-row"><span class="stat-label">Thời lượng nghe</span><span class="stat-value">${Math.floor(totalListenSec/60)}m ${totalListenSec%60}s</span></div>
      <div class="stat-row"><span class="stat-label">Tỷ lệ hoàn thành đề được giao</span><span class="stat-value">${examList.length ? Math.round(doneCount/examList.length*100) : 0}%</span></div>
    </div>
    <div>
      <div style="font-size:12px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:6px">Đề đã giao</div>
      ${examList.length ? examList.map(e => `
        <div style="background:#f8f9fb;border-radius:8px;padding:10px 12px;margin-bottom:6px">
          <div style="font-weight:600;font-size:13px;color:#1a3c6e;margin-bottom:4px">${e.title}</div>
          ${e.attempts ? `
            <div style="font-size:12px;color:#555">Điểm cao nhất: <b style="color:#1e7e34">${e.best}%</b> · Điểm gần nhất: <b>${e.latestScore}%</b> · ${e.attempts} lần làm</div>
            ${e.breakdown ? `<div style="font-size:11px;color:#888;margin-top:4px">${e.breakdown.map(b=>`${b.name}: ${b.ok}/${b.tot}`).join(" · ")}</div>` : ""}
            <div style="font-size:11px;color:#888;margin-top:4px">${e.attemptsSorted.map(s=>`Lần ${s.attempt_number||"?"}: ${s.score}%${s.time_spent_seconds!=null?` (${Math.floor(s.time_spent_seconds/60)}p${s.time_spent_seconds%60}s)`:""}`).join(" · ")}</div>
          ` : `<div style="font-size:12px;color:#aaa">Chưa làm</div>`}
        </div>`).join("") : '<div style="color:#aaa;font-size:13px">Chưa được giao đề nào.</div>'}
    </div>`;
}

async function openExamStats(examId) {
  const exam = mentorExams.find(e => e.id === examId);
  if (!exam) return;
  document.getElementById("infoModalTitle").textContent = "📊 " + exam.title;
  document.getElementById("infoModalBody").innerHTML = '<div style="padding:20px;text-align:center;color:#888">Đang tải...</div>';
  document.getElementById("infoModal").classList.add("open");

  const sharedCount = mentorShares.filter(s => s.item_type === "exam" && s.item_id === examId).length;
  const { data: submissions } = await supabase.from("student_exam_submissions").select("student_id,score").eq("exam_id", examId);
  const byStudent = {};
  (submissions || []).forEach(s => { if (s.score != null && (byStudent[s.student_id] == null || s.score > byStudent[s.student_id])) byStudent[s.student_id] = s.score; });
  const bestScores = Object.values(byStudent);
  const doneCount = bestScores.length;
  const avg = bestScores.length ? Math.round(bestScores.reduce((a, b) => a + b, 0) / bestScores.length) : null;
  const max = bestScores.length ? Math.max(...bestScores) : null;
  const min = bestScores.length ? Math.min(...bestScores) : null;

  document.getElementById("infoModalBody").innerHTML = `
    <div class="stat-row"><span class="stat-label">Đã làm / Được chia sẻ</span><span class="stat-value">${doneCount}/${sharedCount}</span></div>
    <div class="stat-row"><span class="stat-label">Điểm trung bình (nhóm)</span><span class="stat-value">${avg != null ? avg + "%" : "—"}</span></div>
    <div class="stat-row"><span class="stat-label">Điểm cao nhất</span><span class="stat-value">${max != null ? max + "%" : "—"}</span></div>
    <div class="stat-row"><span class="stat-label">Điểm thấp nhất</span><span class="stat-value">${min != null ? min + "%" : "—"}</span></div>`;
}

// ---- Chia sẻ nội dung/đề cho học viên ----
let _shareTarget = null; // {itemType:'history'|'exam', itemId}

async function openShareModal(itemType, itemId) {
  if (!(await ensureMentorSession())) { alert("Vui lòng đăng nhập để chia sẻ."); return; }
  if (!mentorRoster.length) { alert("Bạn chưa có học viên nào trong danh sách. Vào mục 👥 Học viên để thêm trước."); return; }
  _shareTarget = { itemType, itemId };
  renderShareModal();
  document.getElementById("shareModal").classList.add("open");
}
function closeShareModal() { document.getElementById("shareModal").classList.remove("open"); }
function renderShareModal() {
  const el = document.getElementById("shareStudentList");
  if (!el || !_shareTarget) return;
  const { itemType, itemId } = _shareTarget;
  el.innerHTML = mentorRoster.map(r => {
    const shared = mentorShares.some(s => s.item_type===itemType && s.item_id===itemId && s.student_id===r.student_id);
    return `
    <label style="display:flex;align-items:center;gap:8px;padding:8px 4px;border-bottom:1px solid #eef2f7;cursor:pointer">
      <input type="checkbox" ${shared?"checked":""} onchange="toggleShare('${r.student_id}',this.checked)">
      <span style="font-size:13px;color:#0a2540">${r.full_name || r.email}</span>
    </label>`;
  }).join("");
}
async function shareHistoryItem(time) {
  if (!(await ensureMentorSession())) { alert("Vui lòng đăng nhập để chia sẻ."); return; }
  const h = JSON.parse(localStorage.getItem("history_en8") || "[]");
  const item = h.find(x => x.time === time);
  if (item && item.supabaseId) { openShareModal("history", item.supabaseId); return; }
  const { data, error } = await supabase.from("mentor_history").select("id").eq("mentor_id", currentMentor.id).eq("client_id", String(time)).single();
  if (error || !data) { alert("Nội dung này chưa đồng bộ xong lên máy chủ, vui lòng thử lại sau giây lát."); return; }
  openShareModal("history", data.id);
}
async function toggleShare(studentId, on) {
  if (!_shareTarget) return;
  const { itemType, itemId } = _shareTarget;
  if (on) {
    const { error } = await supabase.from("mentor_shares").insert({
      mentor_id: currentMentor.id, student_id: studentId, item_type: itemType, item_id: itemId,
    });
    if (error) { alert("Lỗi chia sẻ: " + error.message); return; }
    mentorShares.push({ mentor_id: currentMentor.id, student_id: studentId, item_type: itemType, item_id: itemId, viewed_at: null });
  } else {
    const { error } = await supabase.from("mentor_shares").delete()
      .eq("mentor_id", currentMentor.id).eq("student_id", studentId).eq("item_type", itemType).eq("item_id", itemId);
    if (error) { alert("Lỗi bỏ chia sẻ: " + error.message); return; }
    mentorShares = mentorShares.filter(s => !(s.item_type===itemType && s.item_id===itemId && s.student_id===studentId));
  }
}

// ====== Student: xem nội dung/đề được chia sẻ + nộp bài ======
let studentShares = [], studentHistoryItems = [], studentExamItems = [];
let studentExamAttemptCounts = {}; // {exam_id: số lần đã nộp} — dùng để khoá đề sau 3 lần

async function loadStudentPortal() {
  if (!currentStudent) return;
  const [{ data: shares, error: shErr }, { data: historyRows, error: hErr }, { data: examRows, error: eErr }, { data: subRows, error: subErr }] = await Promise.all([
    supabase.from("mentor_shares").select("*").eq("student_id", currentStudent.id),
    supabase.from("mentor_history").select("*"),
    supabase.from("mentor_exams").select("*"),
    supabase.from("student_exam_submissions").select("exam_id").eq("student_id", currentStudent.id),
  ]);
  if (shErr) console.error("loadStudentPortal shares error:", shErr);
  if (hErr) console.error("loadStudentPortal history error:", hErr);
  if (eErr) console.error("loadStudentPortal exams error:", eErr);
  if (subErr) console.error("loadStudentPortal submissions error:", subErr);
  studentShares = shares || [];
  studentHistoryItems = historyRows || [];
  studentExamItems = examRows || [];
  studentExamAttemptCounts = {};
  (subRows || []).forEach(s => { studentExamAttemptCounts[s.exam_id] = (studentExamAttemptCounts[s.exam_id] || 0) + 1; });
  renderStudentPortal();
}

function renderStudentPortal() {
  const el = document.getElementById("studentSharedList");
  if (!el) return;
  if (!studentShares.length) {
    el.innerHTML = '<div style="color:#aaa;font-size:13px">Chưa có nội dung nào được chia sẻ cho bạn.</div>';
    return;
  }
  const items = studentShares.map(s => {
    if (s.item_type === "history") {
      const h = studentHistoryItems.find(x => x.id === s.item_id);
      if (!h) return null;
      return { type: "history", id: h.id, title: (h.custom_name || h.text || "").slice(0, 60), level: h.level, viewed: !!s.viewed_at };
    } else {
      const e = studentExamItems.find(x => x.id === s.item_id);
      if (!e) return null;
      return { type: "exam", id: e.id, title: e.title, level: e.level, viewed: !!s.viewed_at, attempts: studentExamAttemptCounts[e.id] || 0 };
    }
  }).filter(Boolean);
  if (!items.length) {
    el.innerHTML = '<div style="color:#aaa;font-size:13px">Chưa có nội dung nào được chia sẻ cho bạn.</div>';
    return;
  }
  el.innerHTML = items.map(it => {
    const examLocked = it.type === "exam" && it.attempts >= 3;
    return `
    <div class="hist-item" style="${examLocked?"opacity:.55":"cursor:pointer"}" ${examLocked?"":`onclick="${it.type==='history'?`openSharedHistory('${it.id}')`:`openSharedExam('${it.id}')`}"`}>
      <div style="flex:1;min-width:0">
        <div class="hist-text">${it.viewed?"":"🆕 "}${it.type==='exam'?"📝 ":"📄 "}${it.title || "(không có tiêu đề)"}</div>
        <div style="font-size:10px;color:#aaa;margin-top:1px">Level ${it.level}${it.type==="exam"?" · Đề/Bài kiểm tra":" · Nội dung"}</div>
        ${examLocked?'<div style="font-size:10px;color:#c0392b;font-weight:600;margin-top:2px">Đã dùng hết 3 lượt làm bài cho đề này</div>':""}
      </div>
    </div>`;
  }).join("");
}

async function markShareViewed(itemType, itemId) {
  if (!currentStudent) return;
  const share = studentShares.find(s => s.item_type === itemType && s.item_id === itemId);
  if (!share || share.viewed_at) return;
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from("mentor_shares").update({ viewed_at: nowIso })
    .eq("mentor_id", share.mentor_id).eq("student_id", currentStudent.id).eq("item_type", itemType).eq("item_id", itemId);
  if (error) { console.error("markShareViewed error:", error); return; }
  share.viewed_at = nowIso;
}

function openSharedHistory(id) {
  const h = studentHistoryItems.find(x => x.id === id);
  if (!h) return;
  markShareViewed("history", id);
  const el = document.getElementById("studentSharedList");
  el.innerHTML = `
    <button onclick="renderStudentPortal()" style="margin-bottom:10px;background:#eaf4fb;border:1px solid #aed6f1;border-radius:6px;padding:6px 12px;cursor:pointer;font-size:13px;color:#1a5f8a">← Quay lại</button>
    <div style="background:#fff;border-radius:12px;padding:16px;box-shadow:0 2px 12px rgba(10,37,64,.08);overflow-x:auto">${h.result || "<i>Không có nội dung hiển thị.</i>"}</div>`;
}
async function openSharedExam(id) {
  markShareViewed("exam", id);
  let attemptNumber = 1;
  if (currentStudent) {
    const { count, error } = await supabase.from("student_exam_submissions")
      .select("id", { count: "exact", head: true })
      .eq("exam_id", id).eq("student_id", currentStudent.id);
    if (!error) attemptNumber = (count || 0) + 1;
  }
  if (attemptNumber > 3) { alert("Đã dùng hết 3 lượt làm bài cho đề này."); return; }
  const timeCapPct = attemptNumber === 1 ? 100 : attemptNumber === 2 ? 85 : 70;
  if (attemptNumber > 1 && !confirm(`Đây là lần ${attemptNumber} — điểm tối đa có thể đạt: ${timeCapPct}%. Tiếp tục?`)) return;
  examOpen(id, { attemptNumber, timeCapPct });
}

// ====== Đồng bộ credit/lịch sử/từ đã lưu lên Supabase (write-through, chạy nền) ======
// localStorage vẫn là bộ nhớ đệm đồng bộ dùng cho toàn bộ UI hiện có; các hàm dưới
// đây chỉ "bắn" thêm dữ liệu lên Supabase mỗi khi có thay đổi, không chặn UI.
let _lastSyncedCredits = null;

async function syncCreditsToSupabase(credits) {
  if (!currentMentor || _lastSyncedCredits === credits) return;
  _lastSyncedCredits = credits;
  const { error } = await supabase.from("mentors").update({ credits }).eq("id", currentMentor.id);
  if (error) console.error("syncCreditsToSupabase error:", error);
}

async function syncHistoryUpsert(item) {
  if (!currentMentor || !item) return;
  const level = item.level || "A1-A2";
  const folderId = item.folderId || getDefaultFolderId(normalizeLibLevel(level));
  if (!folderId) { console.error("syncHistoryUpsert: không tìm thấy folder mặc định cho level", level); return; }
  const { data, error } = await supabase.from("mentor_history").upsert({
    mentor_id: currentMentor.id,
    client_id: String(item.time),
    folder_id: folderId,
    text: item.text || "",
    result: item.result || "",
    level: level,
    custom_name: item.customName || null,
    done: !!item.done,
  }, { onConflict: "mentor_id,client_id" }).select().single();
  if (error) { console.error("syncHistoryUpsert error:", error); return; }
  // Lưu lại id thật của Supabase vào localStorage để dùng cho chia sẻ / thống kê nghe
  if (data) {
    let h = JSON.parse(localStorage.getItem("history_en8") || "[]");
    h = h.map(x => x.time === item.time ? { ...x, supabaseId: data.id } : x);
    localStorage.setItem("history_en8", JSON.stringify(h));
  }
}

async function syncHistoryDelete(time) {
  if (!currentMentor) return;
  const { error } = await supabase.from("mentor_history").delete()
    .eq("mentor_id", currentMentor.id).eq("client_id", String(time));
  if (error) console.error("syncHistoryDelete error:", error);
}

async function syncHistoryClearAll() {
  if (!currentMentor) return;
  const { error } = await supabase.from("mentor_history").delete().eq("mentor_id", currentMentor.id);
  if (error) console.error("syncHistoryClearAll error:", error);
}

async function syncSavedWordUpsert(word) {
  if (!currentMentor || !word) return;
  const { error } = await supabase.from("mentor_saved_words").upsert({
    mentor_id: currentMentor.id,
    word_key: word.key,
    lemma: word.lemma || "",
    meaning: word.meaning || "",
    level: word.level || "",
  }, { onConflict: "mentor_id,word_key" });
  if (error) console.error("syncSavedWordUpsert error:", error);
}

async function syncSavedWordDelete(wordKey) {
  if (!currentMentor) return;
  const { error } = await supabase.from("mentor_saved_words").delete()
    .eq("mentor_id", currentMentor.id).eq("word_key", wordKey);
  if (error) console.error("syncSavedWordDelete error:", error);
}

async function syncSavedWordsClearAll() {
  if (!currentMentor) return;
  const { error } = await supabase.from("mentor_saved_words").delete().eq("mentor_id", currentMentor.id);
  if (error) console.error("syncSavedWordsClearAll error:", error);
}

// ====== Hoạt động học tập dùng chung (user_viewed_words / user_listen_stats) ======
// Dùng chung cho cả mentor lẫn student — chỉ ghi khi đã đăng nhập (currentMentor HOẶC currentStudent).
function getCurrentUserId() {
  return currentMentor ? currentMentor.id : (currentStudent ? currentStudent.id : null);
}
function getCurrentHistorySupabaseId() {
  const h = JSON.parse(localStorage.getItem("history_en8") || "[]");
  const normLevel = {"A1":"A1","A1-A2":"A1-A2","B1":"B1","B2":"B2"}[currentLevel] || "A1-A2";
  const item = h.find(x => x.text === (typeof txt!=="undefined" && txt ? txt.value : "") && (x.level || "A1-A2") === normLevel);
  return item ? (item.supabaseId || null) : null;
}
async function syncViewedWord(wordKey, lemma, meaning, level) {
  const userId = getCurrentUserId();
  if (!userId) return;
  const { error } = await supabase.from("user_viewed_words").upsert({
    user_id: userId, word_key: wordKey, lemma: lemma || "", meaning: meaning || "", level: level || "",
    content_source_id: getCurrentHistorySupabaseId(),
  }, { onConflict: "user_id,word_key" });
  if (error) console.error("syncViewedWord error:", error);
}
async function syncListenStats(contentSourceId, seconds) {
  const userId = getCurrentUserId();
  if (!userId || !contentSourceId) return;
  const { data: existing, error: selErr } = await supabase.from("user_listen_stats").select("*")
    .eq("user_id", userId).eq("content_source_id", contentSourceId).maybeSingle();
  if (selErr) { console.error("syncListenStats select error:", selErr); return; }
  const nowIso = new Date().toISOString();
  if (existing) {
    const { error } = await supabase.from("user_listen_stats").update({
      listen_count: (existing.listen_count || 0) + 1, total_seconds: (existing.total_seconds || 0) + seconds, last_listened_at: nowIso,
    }).eq("id", existing.id);
    if (error) console.error("syncListenStats update error:", error);
  } else {
    const { error } = await supabase.from("user_listen_stats").insert({
      user_id: userId, content_source_id: contentSourceId, listen_count: 1, total_seconds: seconds, last_listened_at: nowIso,
    });
    if (error) console.error("syncListenStats insert error:", error);
  }
}

// Chạy đúng 1 lần ngay sau khi đăng nhập: nếu tài khoản đã có dữ liệu trên Supabase
// (đăng nhập từ máy khác, hoặc lần trước đã đồng bộ) -> tải về, GHI ĐÈ localStorage.
// Nếu tài khoản mới toanh (chưa có gì trên Supabase) mà máy đang có dữ liệu cục bộ
// (dùng thử trước khi đăng ký) -> đẩy dữ liệu cục bộ lên một lần để không mất dữ liệu.
async function hydrateFromSupabase() {
  if (!currentMentor) return;
  const mentorId = currentMentor.id;
  await loadMentorFolders();
  await loadMentorExams();
  await loadMentorRoster();
  await loadMentorShares();
  const s = getStats();

  if ((currentMentor.credits || 0) === 0 && (s.credits || 0) > 0) {
    await supabase.from("mentors").update({ credits: s.credits }).eq("id", mentorId);
    _lastSyncedCredits = s.credits;
  } else {
    s.credits = currentMentor.credits || 0;
    _lastSyncedCredits = s.credits;
  }

  const { data: remoteHistory, error: histErr } = await supabase.from("mentor_history").select("*").eq("mentor_id", mentorId);
  if (!histErr) {
    const localHistory = JSON.parse(localStorage.getItem("history_en8") || "[]");
    if ((remoteHistory || []).length === 0 && localHistory.length > 0) {
      await supabase.from("mentor_history").insert(localHistory.map(h => ({
        mentor_id: mentorId, client_id: String(h.time), text: h.text || "", result: h.result || "",
        level: h.level || "A1-A2", custom_name: h.customName || null, done: !!h.done,
        folder_id: h.folderId || getDefaultFolderId(normalizeLibLevel(h.level || "A1-A2")),
      })));
    } else if ((remoteHistory || []).length > 0) {
      const merged = remoteHistory.map(r => ({
        text: r.text, result: r.result, time: Number(r.client_id), done: r.done,
        level: r.level, customName: r.custom_name || undefined, folderId: r.folder_id,
      })).sort((a, b) => b.time - a.time);
      localStorage.setItem("history_en8", JSON.stringify(merged.slice(0, 100)));
    }
  }

  const { data: remoteWords, error: wordsErr } = await supabase.from("mentor_saved_words").select("*").eq("mentor_id", mentorId);
  if (!wordsErr) {
    if ((remoteWords || []).length === 0 && (s.savedWordsList || []).length > 0) {
      await supabase.from("mentor_saved_words").insert(s.savedWordsList.map(w => ({
        mentor_id: mentorId, word_key: w.key, lemma: w.lemma || "", meaning: w.meaning || "", level: w.level || "",
      })));
    } else if ((remoteWords || []).length > 0) {
      s.savedWordsList = remoteWords.map(w => ({
        key: w.word_key, lemma: w.lemma, meaning: w.meaning, level: w.level, time: new Date(w.created_at).getTime(),
      })).sort((a, b) => b.time - a.time);
      s.savedWords = s.savedWordsList.length;
    }
  }

  saveStats(s);
  renderStats(); updateBadges(); loadLibrarySidebar();
  if (currentPanelId === "pHistory") loadHistory();
  if (currentPanelId === "pSaved") loadSavedPanel();
}

let currentStudent = null; // hồ sơ public.students của người đang đăng nhập, null nếu không phải Student

async function loadCurrentStudent(userId) {
  const { data, error } = await supabase.from("students").select("*").eq("id", userId).single();
  if (error) { return null; } // không có row = tài khoản này là mentor, không phải lỗi thật
  return data;
}

function updateAuthUI() {
  const loggedIn = !!currentMentor || !!currentStudent;
  document.getElementById("btnLogin").style.display = loggedIn ? "none" : "";
  document.getElementById("btnRegister").style.display = loggedIn ? "none" : "";
  document.getElementById("btnLogout").style.display = loggedIn ? "" : "none";
  const label = document.getElementById("mentorEmailLabel");
  label.style.display = loggedIn ? "" : "none";
  label.textContent = currentMentor ? (currentMentor.full_name || currentMentor.email)
    : currentStudent ? (currentStudent.full_name || currentStudent.email) + " (Student)"
    : "";
  const layout = document.querySelector(".layout");
  const portal = document.getElementById("studentPortal");
  if (layout) layout.style.display = currentStudent ? "none" : "flex";
  if (portal) portal.style.display = currentStudent ? "block" : "none";
}

supabase.auth.onAuthStateChange(async (_event, session) => {
  if (!session) { currentMentor = null; currentStudent = null; updateAuthUI(); return; }
  currentMentor = await loadCurrentMentor(session.user.id);
  currentStudent = currentMentor ? null : await loadCurrentStudent(session.user.id);
  updateAuthUI();
  if (currentMentor) await hydrateFromSupabase();
  if (currentStudent && typeof loadStudentPortal === "function") await loadStudentPortal();
});

let authRole = "mentor";
function setAuthRole(role) {
  authRole = role;
  document.getElementById("authRoleMentorBtn")?.classList.toggle("active", role === "mentor");
  document.getElementById("authRoleStudentBtn")?.classList.toggle("active", role === "student");
}
function openAuthModal(mode) {
  authMode = mode;
  authRole = "mentor";
  setAuthRole("mentor");
  document.getElementById("authError").style.display = "none";
  document.getElementById("authEmail").value = "";
  document.getElementById("authPassword").value = "";
  document.getElementById("authFullName").value = "";
  applyAuthModeUI();
  document.getElementById("authModal").classList.add("open");
}
function closeAuthModal() { document.getElementById("authModal").classList.remove("open"); }
function toggleAuthMode() { authMode = authMode === "login" ? "register" : "login"; applyAuthModeUI(); }
function applyAuthModeUI() {
  const isRegister = authMode === "register";
  document.getElementById("authModalTitle").textContent = isRegister ? "🔐 Đăng ký" : "🔐 Đăng nhập";
  document.getElementById("authRegisterFields").style.display = isRegister ? "block" : "none";
  document.getElementById("authSubmitBtn").textContent = isRegister ? "Đăng ký" : "Đăng nhập";
  document.getElementById("authSwitchText").textContent = isRegister ? "Đã có tài khoản?" : "Chưa có tài khoản?";
  document.getElementById("authSwitchLink").textContent = isRegister ? "Đăng nhập" : "Đăng ký";
}

async function submitAuth() {
  const email = document.getElementById("authEmail").value.trim();
  const password = document.getElementById("authPassword").value;
  const fullName = document.getElementById("authFullName").value.trim();
  const errEl = document.getElementById("authError");
  errEl.style.color = "#c0392b";
  errEl.style.display = "none";
  if (!email || !password) { errEl.textContent = "Vui lòng nhập email và mật khẩu."; errEl.style.display = "block"; return; }

  const { data, error } = authMode === "register"
    ? await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName, role: authRole } } })
    : await supabase.auth.signInWithPassword({ email, password });

  if (error) { errEl.textContent = error.message; errEl.style.display = "block"; return; }

  if (authMode === "register" && !data.session) {
    errEl.style.color = "#1e7e34";
    errEl.textContent = "Đăng ký thành công! Kiểm tra email để xác nhận, sau đó đăng nhập.";
    errEl.style.display = "block";
    return;
  }
  closeAuthModal();
}

async function handleSignOut() { await supabase.auth.signOut(); }

const MAX_CREDITS = 30;
const txt = document.getElementById("txt");
const out = document.getElementById("out");
function setStatus(html) {
  const el = document.getElementById("status");
  if (el) el.innerHTML = html;
}
let currentLevel = "A1-A2"; // A2 mode is default
let currentRunId = 0;
let lastAnalyzedData = [];
let currentPanelId = null;
function getStats() {
  return JSON.parse(localStorage.getItem("stats_en8") || JSON.stringify({
    savedWords:0, viewedWords:0, listenCount:0, totalListenSec:0,
    cefrCounts:{A1:0,A2:0,B1:0,B2:0,C1:0,C2:0},
    credits:0, streak:0, lastStudyDate:"",
    activeLessons:[], reviewCount:0,
    savedWordsList:[], viewedWordsList:[]
  }));
}
function saveStats(s) { localStorage.setItem("stats_en8", JSON.stringify(s)); syncCreditsToSupabase(s.credits||0); }
function resetStats() {
  if (!confirm("Reset toàn bộ?")) return;
  localStorage.removeItem("stats_en8"); syncCreditsToSupabase(0); renderStats(); updateBadges();
}
function updateStreak(s) {
  const today = new Date().toDateString();
  if (s.lastStudyDate === today) return;
  const yest = new Date(Date.now()-86400000).toDateString();
  s.streak = s.lastStudyDate === yest ? (s.streak||0)+1 : 1;
  s.lastStudyDate = today;
}
function calcScore(s) {
  const a = Math.min(s.listenCount||0,30)/30*20;
  const b = Math.min(s.savedWords||0,100)/100*20;
  const c = Math.min(s.streak||0,30)/30*20;
  const d = Math.min(s.reviewCount||0,50)/50*40;
  return {total:Math.round(a+b+c+d),sent:Math.round(a),word:Math.round(b),str:Math.round(c),rev:Math.round(d)};
}
function renderStats() {
  const s = getStats();
  const sc = calcScore(s);
  document.getElementById("sp-score").textContent = sc.total;
  const sbScore = document.getElementById("sbScoreNum");
  if(sbScore) sbScore.textContent = sc.total > 999 ? Math.floor(sc.total/1000)+"k" : sc.total;
  document.getElementById("sp-breakdown").textContent = `Câu:${sc.sent} · Từ:${sc.word} · Chuỗi:${sc.str} · Review:${sc.rev}`;
  document.getElementById("sp-saved").textContent = s.savedWords||0;
  document.getElementById("sp-viewed").textContent = s.viewedWords||0;
  document.getElementById("sp-sentences").textContent = s.listenCount||0;
  const dur = s.totalListenSec||0;
  document.getElementById("sp-duration").textContent = String(Math.floor(dur/60)).padStart(2,"0")+"m "+String(dur%60).padStart(2,"0")+"s";
  const cc = s.cefrCounts||{};
  const tot = Object.values(cc).reduce((a,b)=>a+b,0)||1;
  const order=["A1-A2","B1","B1","B2","C1","C2"];
  let topLv="—",topPct=0;
  order.forEach(lv=>{const p=Math.round((cc[lv]||0)/tot*100);if(p>topPct){topPct=p;topLv=lv;}});
  document.getElementById("sp-cefr").textContent = topLv==="—"?"—":`${topLv}: ${topPct}%`;
  const LV_COLOR={A1:"#3c763d",A2:"#31708f",B1:"#8a6d3b",B2:"#a94442",C1:"#6c3483",C2:"#6c3483"};
  document.getElementById("sp-cefr-dist").innerHTML = order.map(lv=>{
    const pct=Math.round((cc[lv]||0)/tot*100);
    return `<div class="cefr-bar-row"><span style="width:22px;font-size:10px;color:${LV_COLOR[lv]};font-weight:bold">${lv}</span><div class="cefr-bar-bg"><div class="cefr-bar-fill" style="width:${pct}%;background:${LV_COLOR[lv]}"></div></div><span style="font-size:10px;color:#888;width:26px;text-align:right">${pct}%</span></div>`;
  }).join("");
  document.getElementById("sp-streak").textContent = (s.streak||0)+" ngày 🔥";
  document.getElementById("sp-credit-label").textContent = `${s.credits||0}/${MAX_CREDITS}`;
  try{
    const exams=mentorExams;
    const done=exams.filter(e=>e.last_score!=null).length;
    const pending=exams.length-done;
    const best=done?Math.max(...exams.filter(e=>e.last_score!=null).map(e=>e.last_score)):null;
    const elDone=document.getElementById("sp-exam-done");
    const elPend=document.getElementById("sp-exam-pending");
    const elBest=document.getElementById("sp-exam-best");
    if(elDone)elDone.textContent=done+" đề";
    if(elPend)elPend.textContent=pending+" đề";
    if(elBest)elBest.textContent=best!=null?best+"%":"—";
    const sbN=document.getElementById("sbScoreNum");
    const sc2=calcScore(s);
    if(sbN)sbN.textContent=sc2.total>999?Math.floor(sc2.total/1000)+"k":sc2.total;
  }catch(e){}
  loadLibrarySidebar();
}
function loadLibrarySidebar() {
  const el = document.getElementById("libraryList");
  const countEl = document.getElementById("libCount");
  if(!el) return;
  const h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  if(countEl) countEl.textContent = h.length + " mục";
  if(!h.length){
    el.innerHTML = '<div style="padding:20px;text-align:center;color:#aaa;font-size:12px">Chưa có nội dung.<br>Phân tích đoạn văn để lưu vào thư viện.</div>';
    return;
  }
  const LV_BG = {A1:"#dff0d8",A2:"#d9edf7","B2":"#fcf8e3"};
  const LV_COL = {A1:"#3c763d",A2:"#31708f","B2":"#8a6d3b"};
  function unsplashUrl(text) {
    return "";
  }
  el.innerHTML = h.map((item,i)=>{
    const lv = (item.level==="A1-A2"?"A1-A2":item.level)||"A1-A2";
    const title = (item.customName||item.text||"").slice(0,80);
    const date = new Date(item.time).toLocaleDateString("vi-VN",{day:"2-digit",month:"2-digit"});
    const LV_BG2 = {A1:"#dff0d8",A2:"#d9edf7","B2":"#fcf8e3"};
    const LV_COL2 = {A1:"#3c763d",A2:"#31708f","B2":"#8a6d3b"};
    const stripe=LV_BG2[lv]||"#eef2fa";
    return `<div class="lib-item" onclick="openHist(${item.time})" title="Nhấn để mở lại">
      <div style="height:6px;background:${LV_COL2[lv]||'#5dade2'}"></div>
      <div class="lib-item-body">
        <div class="lib-item-title">${title||"(không có tiêu đề)"}</div>
        <div class="lib-item-meta">
          <span class="lib-lv-badge" style="background:${LV_BG[lv]||"#eee"};color:${LV_COL[lv]||"#555"}">${lv}</span>
          <span>${date}</span>
          ${item.done?'<span style="color:#28a745">✅</span>':""}
        </div>
      </div>
    </div>`;
  }).join("");
}
function loadLibrarySidebar() {
  const el=document.getElementById("libraryList");
  const countEl=document.getElementById("libCount");
  if(!el) return;
  const h=JSON.parse(localStorage.getItem("history_en8")||"[]");
  if(countEl) countEl.textContent=h.length+" mục";
  if(!h.length){
    el.innerHTML='<div style="padding:20px 12px;text-align:center;color:#aaa;font-size:12px;line-height:1.6">Chưa có nội dung.<br>Phân tích đoạn văn để lưu.</div>';
    return;
  }
  const LV_COLOR={A1:"#2d6a2d",A2:"#31708f","A1-A2":"#3c763d","B1":"#8a6d3b","B2":"#a94442"};
  const THEMES=[
    {k:["family","mother","father","sister","brother","home","house","parent"],e:"🏠",g:"linear-gradient(135deg,#667eea,#764ba2)"},
    {k:["school","study","learn","education","class","student","teacher","homework"],e:"📚",g:"linear-gradient(135deg,#f093fb,#f5576c)"},
    {k:["food","eat","cook","restaurant","meal","healthy","diet","lunch","dinner"],e:"🍽️",g:"linear-gradient(135deg,#4facfe,#00f2fe)"},
    {k:["travel","trip","city","country","place","visit","airport","hotel"],e:"✈️",g:"linear-gradient(135deg,#43e97b,#38f9d7)"},
    {k:["work","job","business","company","office","career","meeting","boss"],e:"💼",g:"linear-gradient(135deg,#fa709a,#fee140)"},
    {k:["nature","animal","bird","tree","forest","ocean","river","garden"],e:"🌿",g:"linear-gradient(135deg,#a18cd1,#fbc2eb)"},
    {k:["technology","phone","computer","internet","app","digital","siri","iphone","laptop"],e:"💻",g:"linear-gradient(135deg,#a1c4fd,#c2e9fb)"},
    {k:["sport","game","play","team","run","exercise","football","basketball"],e:"⚽",g:"linear-gradient(135deg,#f7971e,#ffd200)"},
    {k:["music","song","dance","art","culture","movie","film"],e:"🎵",g:"linear-gradient(135deg,#f6d365,#fda085)"},
    {k:["health","medical","hospital","doctor","medicine","sick"],e:"🏥",g:"linear-gradient(135deg,#96fbc4,#f9f586)"},
    {k:["street","car","drive","road","chicken","walk","bus","traffic"],e:"🚗",g:"linear-gradient(135deg,#ff9a9e,#fecfef)"},
    {k:["town","village","place","where","find","roots","childhood","hometown"],e:"🏡",g:"linear-gradient(135deg,#a18cd1,#fbc2eb)"},
  ];
  const DEFAULT_THEMES=[
    {e:"📖",g:"linear-gradient(135deg,#5f72bd,#9b23ea)"},
    {e:"💡",g:"linear-gradient(135deg,#f77062,#fe5196)"},
    {e:"🌍",g:"linear-gradient(135deg,#11998e,#38ef7d)"},
    {e:"🎓",g:"linear-gradient(135deg,#2196f3,#00bcd4)"},
  ];
  function getTheme(text){
    const t=(text||"").toLowerCase();
    for(const th of THEMES){if(th.k.some(k=>t.includes(k)))return th;}
    const idx=Math.abs([...text].reduce((a,x)=>a+x.charCodeAt(0),0))%DEFAULT_THEMES.length;
    return DEFAULT_THEMES[idx];
  }
  el.innerHTML=h.map((item)=>{
    const lv=item.level||"A1-A2";
    const title=(item.customName||item.text||"").trim();
    const date=new Date(item.time).toLocaleDateString("vi-VN",{day:"2-digit",month:"2-digit"});
    const th=getTheme(title);
    const bg=th.g;
    const emoji=th.e;
    return '<div class="lib-item" onclick="openHist('+item.time+')" title="Nhấn để mở lại">'
      +'<div class="lib-thumb" style="background:'+bg+'">'
        +'<span style="font-size:30px;filter:drop-shadow(0 2px 6px rgba(0,0,0,.25))">'+emoji+'</span>'
        +'<span style="position:absolute;bottom:4px;right:6px;font-size:9px;color:rgba(255,255,255,.9);font-weight:700;letter-spacing:.5px;text-shadow:0 1px 3px rgba(0,0,0,.4)">'+lv+'</span>'
      +'</div>'
      +'<div class="lib-item-body">'
        +'<div class="lib-item-title">'+(title||"(không có tiêu đề)")+'</div>'
        +'<div class="lib-item-meta">'
          +'<span class="lib-lv-badge" style="background:'+( LV_COLOR[lv]||"#555")+'">'+lv+'</span>'
          +'<span>'+date+'</span>'
          +(item.done?'<span>✅</span>':"")
        +'</div>'
      +'</div>'
    +'</div>';
  }).join("");
}
function updateBadges() {
  const s = getStats();
  const hc = JSON.parse(localStorage.getItem("history_en8")||"[]").length;
  const sentCount = (s.savedSentList||[]).length;
  const set = (id, count) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (count > 0) { el.style.display="flex"; el.textContent=count>99?"99+":count; }
    else el.style.display="none";
  };
  set("histBadge", hc);
  set("viewedBadge", s.viewedWords||0);
  set("savedBadge", s.savedWords||0);
  set("savedSentBadge", sentCount);
}
function trackViewedWord(wordKey, lemma, meaning, level) {
  const s = getStats();
  if (!s.viewedWordsList) s.viewedWordsList = [];
  if (!s.viewedWordsList.find(w=>w.key===wordKey)) {
    s.viewedWordsList.unshift({key:wordKey,lemma,meaning,level,time:Date.now()});
    s.viewedWords = (s.viewedWords||0)+1;
    if (s.cefrCounts&&s.cefrCounts[level]!==undefined) s.cefrCounts[level]++;
    saveStats(s); renderStats(); updateBadges();
    syncViewedWord(wordKey, lemma, meaning, level);
  }
}
function toggleSaveWord(wordKey, lemma, meaning, level, btnEl) {
  const s = getStats();
  if (!s.savedWordsList) s.savedWordsList = [];
  const idx = s.savedWordsList.findIndex(w=>w.key===wordKey);
  if (idx>=0) {
    s.savedWordsList.splice(idx,1);
    s.savedWords = Math.max(0,(s.savedWords||1)-1);
    if (btnEl){btnEl.textContent="☆";btnEl.classList.remove("saved");}
    syncSavedWordDelete(wordKey);
  } else {
    s.savedWordsList.unshift({key:wordKey,lemma,meaning,level,time:Date.now()});
    s.savedWords = (s.savedWords||0)+1;
    if (btnEl){btnEl.textContent="🌟";btnEl.classList.add("saved");}
    syncSavedWordUpsert({key:wordKey,lemma,meaning,level});
  }
  saveStats(s); renderStats(); updateBadges();
}
function toggleSaveSent(sentKey, text, btnEl) {
  const s = getStats();
  if (!s.savedSentList) s.savedSentList = [];
  const idx = s.savedSentList.findIndex(x=>x.key===sentKey);
  if (idx>=0) {
    s.savedSentList.splice(idx,1);
    if (btnEl){btnEl.textContent="☆";btnEl.classList.remove("saved");}
  } else {
    s.savedSentList.unshift({key:sentKey,text,time:Date.now()});
    if (btnEl){btnEl.textContent="🌟";btnEl.classList.add("saved");}
  }
  saveStats(s); updateBadges();
}
function togglePanel(id) {
  if (currentPanelId === id) { closePanel(); return; }
  closePanel(false);
  currentPanelId = id;
  const panel = document.getElementById(id);
  if (!panel) { console.error("Panel not found:", id); return; }
  panel.classList.add("open");
  document.querySelectorAll(".sb-btn").forEach(b=>b.classList.remove("active"));
  const sbMap={pHistory:"sbHistory",pViewed:"sbViewed",pSaved:"sbSaved",pSavedSent:"sbSavedSent",pRoster:"sbRoster"};
  if (sbMap[id]) document.getElementById(sbMap[id])?.classList.add("active");
  if (id==="pHistory")    loadHistory();
  if (id==="pViewed")     loadViewedPanel();
  if (id==="pSaved")      loadSavedPanel();
  if (id==="pSavedSent")  loadSavedSentPanel();
  if (id==="pRoster")     loadRosterPanel();
}
function closePanel(resetActive=true) {
  if (currentPanelId) document.getElementById(currentPanelId)?.classList.remove("open");
  if (resetActive) document.querySelectorAll(".sb-btn").forEach(b=>b.classList.remove("active"));
  currentPanelId = null;
}
function loadViewedPanel() {
  const s = getStats();
  const list = s.viewedWordsList||[];
  const saved = new Set((s.savedWordsList||[]).map(w=>w.key));
  const LV_COLOR={A1:"#3c763d",A2:"#31708f",B1:"#8a6d3b",B2:"#a94442",C1:"#6c3483",C2:"#6c3483"};
  if(!list.length){
    document.getElementById("viewedContent").innerHTML='<div style="color:#aaa;font-size:13px;padding:8px">Chưa có từ nào</div>';
    return;
  }
  document.getElementById("viewedContent").innerHTML = list.map(w=>{
    const isSaved = saved.has(w.key);
    return `<div class="viewed-item">
      <button class="v-tts" data-word="${(w.lemma||'').replace(/"/g,'&quot;')}" style="background:none;border:none;cursor:pointer;color:#5dade2;font-size:14px;padding:0 4px 0 0;flex-shrink:0">🔊</button>
      <span class="viewed-word">${w.lemma||''}</span>
      <span style="font-size:10px;padding:1px 5px;border-radius:4px;background:#eee;color:${LV_COLOR[w.level]||'#888'};flex-shrink:0">${w.level||''}</span>
      <span class="viewed-meaning" style="flex:1">${w.meaning||''}</span>
      <button class="v-star word-star ${isSaved?'saved':''}"
        data-key="${(w.key||'').replace(/"/g,'&quot;')}"
        data-lemma="${(w.lemma||'').replace(/"/g,'&quot;')}"
        data-meaning="${(w.meaning||'').replace(/"/g,'&quot;')}"
        data-level="${w.level||''}"
        style="background:none;border:none;cursor:pointer;font-size:14px;color:#f5a623;padding:0;flex-shrink:0">${isSaved?'🌟':'☆'}</button>
    </div>`;
  }).join('');
  document.querySelectorAll('#viewedContent .v-tts').forEach(btn=>{
    btn.onclick=()=>playWordTTS(btn.dataset.word);
  });
  document.querySelectorAll('#viewedContent .v-star').forEach(btn=>{
    btn.onclick=()=>toggleSaveWord(btn.dataset.key,btn.dataset.lemma,btn.dataset.meaning,btn.dataset.level,btn);
  });
}
function loadSavedPanel() {
  const s = getStats();
  const list = s.savedWordsList||[];
  const LV_COLOR={A1:"#3c763d",A2:"#31708f",B1:"#8a6d3b",B2:"#a94442",C1:"#6c3483",C2:"#6c3483"};
  if(!list.length){
    document.getElementById("savedContent").innerHTML='<div style="color:#aaa;font-size:13px;padding:8px">Chưa lưu từ nào</div>';
    return;
  }
  document.getElementById("savedContent").innerHTML = list.map(w=>`<div class="viewed-item">
    <button class="s-tts" data-word="${(w.lemma||'').replace(/"/g,'&quot;')}" style="background:none;border:none;cursor:pointer;color:#5dade2;font-size:14px;padding:0 4px 0 0;flex-shrink:0">🔊</button>
    <span class="viewed-word">${w.lemma||''}</span>
    <span style="font-size:10px;padding:1px 5px;border-radius:4px;background:#eee;color:${LV_COLOR[w.level]||'#888'};flex-shrink:0">${w.level||''}</span>
    <span class="viewed-meaning">${w.meaning||''}</span>
    <button class="s-star"
      data-key="${(w.key||'').replace(/"/g,'&quot;')}"
      data-lemma="${(w.lemma||'').replace(/"/g,'&quot;')}"
      data-meaning="${(w.meaning||'').replace(/"/g,'&quot;')}"
      data-level="${w.level||''}"
      style="background:none;border:none;cursor:pointer;font-size:14px;color:#f5a623;padding:0;flex-shrink:0">🌟</button>
  </div>`).join('');
  document.querySelectorAll('#savedContent .s-tts').forEach(btn=>{
    btn.onclick=()=>playWordTTS(btn.dataset.word);
  });
  document.querySelectorAll('#savedContent .s-star').forEach(btn=>{
    btn.onclick=()=>toggleSaveWord(btn.dataset.key,btn.dataset.lemma,btn.dataset.meaning,btn.dataset.level,btn);
  });
}
function toggleStatsDropdown() {
  closePanel(false);
  const dd = document.getElementById("statsDropdown");
  const isOpen = dd.classList.contains("open");
  dd.classList.toggle("open", !isOpen);
  if (!isOpen) renderStats();
}
document.addEventListener("click", e=>{
  if (!e.target.closest(".stats-wrap") && !e.target.closest("#sbScore") && !e.target.closest("#statsDropdown")) document.getElementById("statsDropdown").classList.remove("open");
  if (!e.target.closest(".ab-speed-wrap")) document.getElementById("speedDropdown")?.classList.remove("open");
  if (!e.target.closest(".mode-wrap")) document.getElementById("modeDropdown").classList.remove("open");
  const inPanel=e.target.closest(".side-panel"); const inSB=e.target.closest(".sidebar"); const inStats=e.target.closest(".stats-wrap"); if(!inPanel && !inSB && !inStats) closePanel(false);
});
function toggleModeDropdown() { document.getElementById("modeDropdown").classList.toggle("open"); }
function selectMode(lv) {
  currentLevel = lv;
  const lblMap = {"A1":"A1","A1-A2":"A2","B1":"B1","B2":"B2"};
  document.getElementById("modeLbl").textContent = lblMap[lv] || lv;
  if(document.getElementById("modeA1new")) document.getElementById("modeA1new").classList.toggle("active", lv==="A1");
  document.getElementById("modeA1").classList.toggle("active", lv==="A1-A2");
  document.getElementById("modeA2").classList.toggle("active", lv==="B1");
  document.getElementById("modeB12").classList.toggle("active", lv==="B2");
  document.getElementById("modeDropdown").classList.remove("open");
}
function saveHistory(text, result="", folderId=null) {
  let h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  const normLevel = {"A1":"A1","A1-A2":"A1-A2","B1":"B1","B2":"B2"}[currentLevel] || "A1-A2";
  // Khoá xác định trùng lặp = (text, level): cùng text KHÁC level -> nội dung mới,
  // không đụng bản ghi level cũ. Cùng text CÙNG level -> tái sử dụng time cũ để
  // upsert Supabase ghi đè đúng vị trí/folder cũ (khoá (mentor_id, client_id)).
  const existing = h.find(x => x.text === text && (x.level || "A1-A2") === normLevel);
  const fid = (existing && existing.folderId) || folderId || getDefaultFolderId(normalizeLibLevel(normLevel));
  const item = {
    text, result,
    time: existing ? existing.time : Date.now(),
    done: existing ? existing.done : false,
    level: normLevel,
    customName: existing ? existing.customName : undefined,
    folderId: fid,
  };
  h = h.filter(x => !(x.text === text && (x.level || "A1-A2") === normLevel));
  h.unshift(item);
  localStorage.setItem("history_en8", JSON.stringify(h.slice(0,100)));
  syncHistoryUpsert(item);
  updateBadges();
  loadLibrarySidebar();
}
function fmtHistTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  const today = now.toDateString();
  const yesterday = new Date(now-86400000).toDateString();
  const hhmm = d.getHours().toString().padStart(2,"0")+":"+d.getMinutes().toString().padStart(2,"0");
  if (d.toDateString() === today)     return "hôm nay " + hhmm;
  if (d.toDateString() === yesterday) return "hôm qua " + hhmm;
  return `${d.getDate()}/${d.getMonth()+1} ${hhmm}`;
}
// ====== Thư viện học tập — giao diện File Explorer (2 cột: cây folder / nội dung) ======
let libExplorerFolderId = null;

function openLibraryExplorer() {
  document.getElementById("libraryExplorer").classList.add("open");
  if (!libExplorerFolderId || !mentorFolders.some(f => f.id === libExplorerFolderId)) {
    const first = mentorFolders.find(f => f.folder_type === "content" && f.is_auto);
    libExplorerFolderId = first ? first.id : null;
  }
  renderLibExplorerTree();
  renderLibExplorerList();
}
function closeLibraryExplorer() {
  document.getElementById("libraryExplorer").classList.remove("open");
}
function refreshLibraryExplorer() {
  if (document.getElementById("libraryExplorer")?.classList.contains("open")) {
    renderLibExplorerTree();
    renderLibExplorerList();
  }
}
function libExplorerSelect(folderId) {
  libExplorerFolderId = folderId;
  renderLibExplorerTree();
  renderLibExplorerList();
}
function toggleLibTreeNode(key) {
  const el = document.getElementById(key);
  if (!el) return;
  const open = el.style.display !== "none";
  el.style.display = open ? "none" : "block";
  const arrow = document.getElementById("arrow_"+key);
  if (arrow) arrow.textContent = open ? "▶" : "▼";
}
function renderLibExplorerTree() {
  const treeEl = document.getElementById("libExplorerTree");
  if (!treeEl) return;
  let html = "";
  ["A1-A2","B1","B2"].forEach(lv => {
    const folders = mentorFolders.filter(f => (f.folder_type==="content"||f.folder_type==="review") && f.level===lv)
      .sort((a,b) => (b.is_auto?1:0) - (a.is_auto?1:0));
    if (!folders.length) return;
    html += `<div class="lib-tree-level">${lv}</div>`;
    html += folders.map(f => {
      const examSub = mentorFolders.find(x => x.parent_folder_id===f.id && x.folder_type==="exam_sub");
      const selected = f.id===libExplorerFolderId;
      const fKey = "libf_"+f.id.replace(/[^a-z0-9]/gi,"");
      let node = `<div class="lib-tree-item${selected?" selected":""}">
        <span onclick="libExplorerSelect('${f.id}')" style="flex:1;display:flex;align-items:center;gap:6px;min-width:0">
          ${examSub?`<span class="lib-tree-arrow" onclick="event.stopPropagation();toggleLibTreeNode('${fKey}')" id="arrow_${fKey}">▶</span>`:'<span class="lib-tree-arrow-spacer"></span>'}
          <span>📁</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${f.name}</span>
        </span>
        ${!f.is_auto?`<span class="lib-tree-actions">
          <button class="lib-tree-act-btn" onclick="event.stopPropagation();renameFolder('${f.id}')" title="Đổi tên">✏️</button>
          <button class="lib-tree-act-btn" onclick="event.stopPropagation();deleteFolder('${f.id}')" title="Xoá">🗑</button>
        </span>`:""}
      </div>`;
      if (examSub) {
        const esSelected = examSub.id===libExplorerFolderId;
        node += `<div id="${fKey}" style="display:none;margin-left:16px">
          <div class="lib-tree-item${esSelected?" selected":""}" onclick="libExplorerSelect('${examSub.id}')">
            <span class="lib-tree-arrow-spacer"></span><span>📁</span><span>Đề kiểm tra</span>
          </div>
        </div>`;
      }
      return node;
    }).join("");
  });
  treeEl.innerHTML = html || '<div class="lib-empty">Chưa có folder nào.</div>';
}
function libExplorerBreadcrumb() {
  const f = mentorFolders.find(x => x.id===libExplorerFolderId);
  if (!f) return "📚 Thư viện học tập";
  if (f.folder_type==="exam_sub") {
    const parent = mentorFolders.find(x => x.id===f.parent_folder_id);
    return `${f.level} / ${parent?parent.name:""} / Đề kiểm tra`;
  }
  return `${f.level} / ${f.name}`;
}
function renderLibExplorerList() {
  const listEl = document.getElementById("libExplorerList");
  const bcEl = document.getElementById("libBreadcrumb");
  if (!listEl) return;
  if (bcEl) bcEl.textContent = libExplorerBreadcrumb();
  const f = mentorFolders.find(x => x.id===libExplorerFolderId);
  if (!f) { listEl.innerHTML = '<div class="lib-empty">Chọn 1 folder bên trái để xem nội dung.</div>'; return; }

  const q = (document.getElementById("libSearchInput")?.value||"").trim().toLowerCase();
  const matches = name => !q || (name||"").toLowerCase().includes(q);

  const h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  const items = f.folder_type==="exam_sub" ? [] : h.filter(x => x.folderId===f.id && matches(x.customName||x.text));
  const exams = mentorExams.filter(e => e.folder_id===f.id && matches(e.title));

  if (!items.length && !exams.length) { listEl.innerHTML = '<div class="lib-empty">Trống.</div>'; return; }

  let html = "";
  items.forEach(x => {
    html += `<div class="lib-row">
      <span class="lib-row-icon">📄</span>
      <span class="lib-row-name" onclick="openHist(${x.time})" title="Nhấn để mở lại">${(x.customName||x.text||"").slice(0,70)}</span>
      <span class="lib-row-type">Phân tích</span>
      <span class="lib-row-actions">
        <button class="lib-act-btn" onclick="renameHistPrompt(${x.time})" title="Đổi tên">✏️</button>
        <button class="lib-act-btn" onclick="shareHistoryItem(${x.time})" title="Chia sẻ">🔗</button>
        <button class="lib-act-btn" onclick="openMoveModal('history',${x.time})" title="Di chuyển đến...">➡️</button>
        <button class="lib-act-btn" onclick="deleteHist(${x.time})" title="Xoá">🗑</button>
      </span>
    </div>`;
  });
  exams.forEach(e => {
    const isDe = e.kind==="de";
    html += `<div class="lib-row">
      <span class="lib-row-icon">${isDe?"🎓":"📝"}</span>
      <span class="lib-row-name" onclick="openExam('${e.id}')" title="Nhấn để mở">${e.title}</span>
      <span class="lib-row-type">${isDe?"Đề":"Bài KT"}${e.last_score!=null?" · "+e.last_score+"%":""}</span>
      <span class="lib-row-actions">
        <button class="lib-act-btn" onclick="openExamStats('${e.id}')" title="Thống kê">📊</button>
        <button class="lib-act-btn" onclick="renameExam('${e.id}')" title="Đổi tên">✏️</button>
        <button class="lib-act-btn" onclick="openShareModal('exam','${e.id}')" title="Chia sẻ">🔗</button>
        <button class="lib-act-btn" onclick="openMoveModal('exam','${e.id}')" title="Di chuyển đến...">➡️</button>
        <button class="lib-act-btn" onclick="deleteExam('${e.id}')" title="Xoá">🗑</button>
      </span>
    </div>`;
  });
  listEl.innerHTML = html;
}
function createFolderInExplorer() {
  const f = mentorFolders.find(x => x.id===libExplorerFolderId);
  createFolder(f ? f.level : "A1-A2");
}
function renameHistPrompt(ts) {
  let h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  const item = h.find(x => x.time===ts);
  if (!item) return;
  const current = item.customName || item.text;
  const name = prompt("Đổi tên:", current);
  if (!name || !name.trim() || name.trim()===current) return;
  item.customName = name.trim();
  localStorage.setItem("history_en8", JSON.stringify(h));
  syncHistoryUpsert(item);
  refreshLibraryExplorer();
}
async function renameExam(examId) {
  const e = mentorExams.find(x => x.id===examId);
  if (!e) return;
  const name = prompt("Đổi tên đề:", e.title);
  if (!name || !name.trim() || name.trim()===e.title) return;
  const { error } = await supabase.from("mentor_exams").update({ title: name.trim() }).eq("id", examId);
  if (error) { alert("Lỗi đổi tên: "+error.message); return; }
  e.title = name.trim();
  refreshLibraryExplorer();
  if (document.getElementById("savedExamsList")) loadSavedExamsList();
}

// ---- "Di chuyển đến..." — chỉ cho phép chuyển giữa các folder CÙNG level, để không phá vỡ
// quy ước hiện có (nội dung/đề luôn hiển thị đúng nhóm level dựa trên level của chính nó) ----
let _moveTarget = null;
function openMoveModal(itemType, itemId) {
  let level, kind;
  if (itemType==="history") {
    const h = JSON.parse(localStorage.getItem("history_en8")||"[]");
    const item = h.find(x => x.time===itemId);
    if (!item) return;
    level = normalizeLibLevel(item.level||"A1-A2");
  } else {
    const e = mentorExams.find(x => x.id===itemId);
    if (!e) return;
    level = e.level; kind = e.kind;
  }
  const candidates = (itemType==="history" || kind==="de")
    ? mentorFolders.filter(f => f.folder_type==="content" && f.level===level && f.id !== libExplorerFolderId)
    : [];
  if (!candidates.length) { alert("Không có folder khác để chuyển đến."); return; }
  _moveTarget = { itemType, itemId, kind };
  document.getElementById("moveModalList").innerHTML = candidates.map(f =>
    `<div class="lib-move-option" onclick="confirmMove('${f.id}')">📁 ${f.name}</div>`
  ).join("");
  document.getElementById("moveModal").classList.add("open");
}
function closeMoveModal() {
  document.getElementById("moveModal").classList.remove("open");
  _moveTarget = null;
}
async function confirmMove(targetFolderId) {
  if (!_moveTarget) return;
  const { itemType, itemId, kind } = _moveTarget;
  if (itemType==="history") {
    let h = JSON.parse(localStorage.getItem("history_en8")||"[]");
    const item = h.find(x => x.time===itemId);
    if (!item) return;
    item.folderId = targetFolderId;
    localStorage.setItem("history_en8", JSON.stringify(h));
    await syncHistoryUpsert(item);
  } else {
    let finalFolderId = targetFolderId;
    if (kind==="de") finalFolderId = await getOrCreateExamSubFolder(targetFolderId);
    if (!finalFolderId) { alert("Không xác định được folder đích."); return; }
    const { error } = await supabase.from("mentor_exams").update({ folder_id: finalFolderId }).eq("id", itemId);
    if (error) { alert("Lỗi di chuyển: "+error.message); return; }
    const e = mentorExams.find(x => x.id===itemId);
    if (e) e.folder_id = finalFolderId;
  }
  closeMoveModal();
  refreshLibraryExplorer();
}

function loadHistory() {
  refreshLibraryExplorer();
  const h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  const el = document.getElementById("historyContent");
  if (!el) return;
  const lvStyles = {
    "A1-A2":  {color:"#3c763d", bg:"#dff0d8", border:"#a8d5a2", label:"A1-A2"},
    "B1":     {color:"#31708f", bg:"#d9edf7", border:"#9acce0", label:"B1"},
    "B2":     {color:"#8a6d3b", bg:"#fcf8e3", border:"#d4b96a", label:"B2"},
  };
  const renderItem = x => `
    <div class="hist-item">
      <div style="flex:1;min-width:0;cursor:pointer" ondblclick="renameHist(${x.time},this)" title="Double-click để đổi tên">
        <div class="hist-text${x.done?" done":""}" id="htxt_${x.time}">${(x.customName||x.text).slice(0,50)}</div>
        <div style="font-size:10px;color:#aaa;margin-top:1px">${fmtHistTime(x.time)}</div>
      </div>
      <div class="hist-actions">
        <button class="hist-btn" onclick="markDone(${x.time})" title="${x.done?"Bỏ hoàn thành":"Hoàn thành"}">${x.done?"✅":"⬜"}</button>
        <button class="hist-btn" onclick="openHist(${x.time})" title="Mở lại">📄</button>
        <button class="hist-btn" onclick="shareHistoryItem(${x.time})" title="Chia sẻ">🔗</button>
        <button class="hist-btn" onclick="deleteHist(${x.time})" title="Xóa" style="color:#dc3545">🗑</button>
      </div>
    </div>`;

  let html = "";
  ["A1-A2","B1","B2"].forEach(lv => {
    const levelItems = h.filter(x => normalizeLibLevel(x.level||"A1-A2") === lv);
    const levelFolders = mentorFolders.filter(f => f.folder_type==="content" && f.level===lv)
      .sort((a,b) => (b.is_auto?1:0) - (a.is_auto?1:0));
    if (!levelItems.length && !levelFolders.length) return;
    const st = lvStyles[lv] || {color:"#555",bg:"#eee",border:"#ccc"};
    const gid = "hg_"+lv.replace(/[^a-z0-9]/gi,"");

    let foldersHtml = "";
    if (levelFolders.length) {
      foldersHtml = levelFolders.map(f => {
        const items = levelItems.filter(x => x.folderId === f.id);
        const fgid = "fg_"+f.id.replace(/[^a-z0-9]/gi,"");
        const examSub = mentorFolders.find(x => x.parent_folder_id===f.id && x.folder_type==="exam_sub");
        return `
        <div style="margin-bottom:4px">
          <div style="display:flex;align-items:center;gap:6px;padding:5px 8px;background:#fff;border:1px solid #eef2f7;border-radius:6px">
            <span onclick="toggleHG('${fgid}')" style="cursor:pointer;flex:1;display:flex;align-items:center;gap:6px;min-width:0">
              <span id="hg_arrow_${fgid}" style="font-size:10px;color:#888;transition:transform .2s">▶</span>
              <span style="font-size:12px;font-weight:600;color:#0a2540">📁 ${f.name}</span>
              <span style="font-size:10px;color:#aaa">${items.length} mục${examSub?" · có đề":""}</span>
            </span>
            ${!f.is_auto?`
            <button class="hist-btn" onclick="renameFolder('${f.id}')" title="Đổi tên folder" style="font-size:12px">✏️</button>
            <button class="hist-btn" onclick="deleteFolder('${f.id}')" title="Xoá folder" style="font-size:12px;color:#dc3545">🗑</button>`:""}
          </div>
          <div id="${fgid}" style="display:none;margin-left:14px;padding-left:6px;border-left:2px solid #eef2f7;margin-top:2px">
            ${items.length ? items.map(renderItem).join("") : '<div style="color:#bbb;font-size:11px;padding:6px 4px">Trống</div>'}
          </div>
        </div>`;
      }).join("");
    }
    // Nội dung chưa có folder_id hợp lệ (dữ liệu cũ hoặc chưa đăng nhập) -> hiện ngay dưới level
    const unassigned = levelItems.filter(x => !levelFolders.some(f => f.id === x.folderId));

    html += `
    <div style="margin-bottom:6px">
      <div onclick="toggleHG('${gid}')" style="
        display:flex;align-items:center;gap:6px;
        padding:7px 12px;background:${st.bg};
        border:1px solid ${st.border};border-radius:8px;
        cursor:pointer;user-select:none
      ">
        <span id="hg_arrow_${gid}" style="font-size:11px;color:${st.color};transition:transform .2s">▶</span>
        <span style="font-size:12px;font-weight:bold;color:${st.color}">${st.label||lv}</span>
        <span style="font-size:11px;color:#888;margin-left:2px">${levelItems.length} mục</span>
      </div>
      <div id="${gid}" style="display:none;border-left:3px solid ${st.border};margin-left:6px;padding-left:6px;margin-top:4px">
        ${foldersHtml}
        ${unassigned.map(renderItem).join("")}
        <button onclick="createFolder('${lv}')" style="width:100%;margin-top:4px;background:#f7fbff;border:1.5px dashed #aed6f1;border-radius:6px;padding:6px;color:#1a5f8a;font-size:11px;cursor:pointer">+ Tạo folder mới (${lv})</button>
      </div>
    </div>`;
  });
  el.innerHTML = html || '<div style="color:#aaa;font-size:13px;padding:8px">Chưa có lịch sử</div>';
}

async function createFolder(level) {
  if (!(await ensureMentorSession())) { alert("Vui lòng đăng nhập để tạo folder."); return; }
  const name = prompt("Tên folder mới:");
  if (!name || !name.trim()) return;
  const { data, error } = await supabase.from("mentor_folders").insert({
    mentor_id: currentMentor.id, name: name.trim(), level, folder_type: "content", is_auto: false,
  }).select().single();
  if (error) { alert("Lỗi tạo folder: " + error.message); return; }
  mentorFolders.push(data);
  loadHistory();
}

async function renameFolder(folderId) {
  const f = mentorFolders.find(x => x.id === folderId);
  if (!f || f.is_auto) return;
  const name = prompt("Đổi tên folder:", f.name);
  if (!name || !name.trim() || name.trim() === f.name) return;
  const { error } = await supabase.from("mentor_folders").update({ name: name.trim() }).eq("id", folderId);
  if (error) { alert("Lỗi đổi tên: " + error.message); return; }
  f.name = name.trim();
  loadHistory();
}

async function deleteFolder(folderId) {
  const f = mentorFolders.find(x => x.id === folderId);
  if (!f) return;
  if (f.is_auto) { alert("Không thể xoá folder mặc định (Chưa phân loại / Ôn Tập)."); return; }
  if (!confirm(`Xoá folder "${f.name}"?`)) return;

  const h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  const itemsInFolder = h.filter(x => x.folderId === folderId);
  const examSub = mentorFolders.find(x => x.parent_folder_id === folderId && x.folder_type === "exam_sub");

  if (itemsInFolder.length > 0 || examSub) {
    const deleteAll = confirm(
      `Folder này có ${itemsInFolder.length} nội dung${examSub ? " và đề bên trong \"Đề kiểm tra\"" : ""}.\n\n` +
      `Nhấn OK để XOÁ LUÔN tất cả bên trong (không hoàn tác được).\n` +
      `Nhấn Cancel để CHUYỂN nội dung sang "Chưa phân loại" trước (đề trong "Đề kiểm tra" nếu có vẫn sẽ bị xoá theo folder).`
    );
    if (deleteAll) {
      await Promise.all(itemsInFolder.map(item => syncHistoryDelete(item.time)));
      const newH = h.filter(x => x.folderId !== folderId);
      localStorage.setItem("history_en8", JSON.stringify(newH));
    } else {
      const defaultId = getDefaultFolderId(f.level);
      if (!defaultId) { alert("Không tìm thấy folder 'Chưa phân loại' để chuyển nội dung sang."); return; }
      const movedItems = itemsInFolder.map(x => ({ ...x, folderId: defaultId }));
      await Promise.all(movedItems.map(item => syncHistoryUpsert(item)));
      const newH = h.map(x => x.folderId === folderId ? { ...x, folderId: defaultId } : x);
      localStorage.setItem("history_en8", JSON.stringify(newH));
    }
  }

  const { error } = await supabase.from("mentor_folders").delete().eq("id", folderId);
  if (error) { alert("Lỗi xoá folder: " + error.message); return; }
  mentorFolders = mentorFolders.filter(x => x.id !== folderId && x.parent_folder_id !== folderId);
  loadHistory(); updateBadges();
}
function renameHist(ts, container) {
  const el = document.getElementById("htxt_"+ts);
  if (!el) return;
  const current = el.textContent;
  const inp = document.createElement("input");
  inp.value = current;
  inp.style.cssText = "width:100%;font-size:12px;padding:2px 4px;border:1.5px solid #2e86c1;border-radius:4px;outline:none;background:#f8fbff";
  el.replaceWith(inp);
  inp.focus();
  inp.select();
  const save = () => {
    const val = inp.value.trim() || current;
    const span = document.createElement("div");
    span.className = el.className;
    span.id = el.id;
    span.textContent = val.slice(0,50);
    inp.replaceWith(span);
    let h = JSON.parse(localStorage.getItem("history_en8")||"[]");
    h = h.map(x => x.time===ts ? {...x, customName:val} : x);
    localStorage.setItem("history_en8", JSON.stringify(h));
    syncHistoryUpsert(h.find(x=>x.time===ts));
  };
  inp.addEventListener("blur", save);
  inp.addEventListener("keydown", e => {
    if (e.key==="Enter") { inp.blur(); }
    if (e.key==="Escape") { inp.value=current; inp.blur(); }
  });
}
function toggleHG(gid) {
  const el = document.getElementById(gid);
  if (!el) return;
  const open = el.style.display !== "none";
  el.style.display = open ? "none" : "block";
  const arrow = document.getElementById("hg_arrow_"+gid);
  if (arrow) arrow.style.transform = open ? "" : "rotate(90deg)";
}
function markDone(id) {
  let h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  const item = h.find(x=>x.time===id);
  if (item) { item.done=!item.done; localStorage.setItem("history_en8",JSON.stringify(h)); syncHistoryUpsert(item); loadHistory(); }
}
function openHist(id) {
  let h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  const item = h.find(x=>x.time===id);
  if (!item) return;
  txt.value = item.text;
  if (item.result) { out.innerHTML = item.result; }
  closePanel();
  const s=getStats();s.reviewCount=(s.reviewCount||0)+1;saveStats(s);
}
function deleteHist(id) {
  let h = JSON.parse(localStorage.getItem("history_en8")||"[]");
  localStorage.setItem("history_en8", JSON.stringify(h.filter(x=>x.time!==id)));
  syncHistoryDelete(id);
  loadHistory(); updateBadges();
}
function clearHistory() {
  if (!confirm("Xóa toàn bộ lịch sử?")) return;
  localStorage.removeItem("history_en8"); syncHistoryClearAll(); loadHistory(); updateBadges();
}
let _delConfirmTimer = null;
function toggleDeleteDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById("deleteDropdown");
  const btn = document.getElementById("deleteBtnMain");
  const isOpen = dd.style.display !== "none";
  if (isOpen) { dd.style.display="none"; return; }
  document.querySelectorAll(".del-item").forEach(el=>{
    el.classList.remove("confirming");
    el.dataset.origText = el.dataset.origText || el.innerHTML;
    el.innerHTML = el.dataset.origText;
  });
  const rect = btn.getBoundingClientRect();
  dd.style.display = "block";
  dd.style.left = (rect.right + 6) + "px";
  dd.style.top = rect.top + "px";
}
function confirmDelete(type, el) {
  if (!el.classList.contains("confirming")) {
    document.querySelectorAll(".del-item").forEach(x=>{
      x.classList.remove("confirming");
      if(x.dataset.origText) x.innerHTML = x.dataset.origText;
    });
    el.dataset.origText = el.dataset.origText || el.innerHTML;
    el.classList.add("confirming");
    el.innerHTML = "⚠ Nhấn lần nữa để xác nhận";
    if (_delConfirmTimer) clearTimeout(_delConfirmTimer);
    _delConfirmTimer = setTimeout(()=>{
      el.classList.remove("confirming");
      el.innerHTML = el.dataset.origText;
    }, 3000);
    return;
  }
  el.classList.remove("confirming");
  el.innerHTML = el.dataset.origText;
  if (_delConfirmTimer) { clearTimeout(_delConfirmTimer); _delConfirmTimer=null; }
  document.getElementById("deleteDropdown").style.display="none";
  if (type==="hist") {
    localStorage.removeItem("history_en8");
    syncHistoryClearAll();
    if (document.getElementById("pHistory")?.classList.contains("open")) loadHistory();
  } else if (type==="viewed") {
    const s=getStats(); s.viewedWordsList=[]; s.viewedWords=0; saveStats(s);
    if (document.getElementById("pViewed")?.classList.contains("open")) loadViewedPanel();
  } else if (type==="saved") {
    const s=getStats(); s.savedWordsList=[]; s.savedWords=0; saveStats(s);
    syncSavedWordsClearAll();
    if (document.getElementById("pSaved")?.classList.contains("open")) loadSavedPanel();
  } else if (type==="sent") {
    const s=getStats(); s.savedSentList=[]; saveStats(s);
    if (document.getElementById("pSavedSent")?.classList.contains("open")) loadSavedSentPanel();
  } else if (type==="all") {
    ["history_en8","stats_en8"].forEach(k=>localStorage.removeItem(k));
    syncHistoryClearAll(); syncSavedWordsClearAll(); syncCreditsToSupabase(0);
    out.innerHTML=""; txt.value="";
    renderStats(); loadHistory();
  }
  updateBadges(); renderStats();
}
document.addEventListener("click", e=>{
  const dd=document.getElementById("deleteDropdown");
  if(dd&&dd.style.display!=="none"&&!e.target.closest("#deleteDropdown")&&!e.target.closest("#deleteBtnMain")){
    dd.style.display="none";
  }
});
let _voices=[], _voiceFem=null, _voiceMal=null;
let isListeningAll=false, isRepeat=false, currentPlayUid=null;
function loadVoices(){
  const all=speechSynthesis.getVoices();
  _voices=all.filter(v=>v.lang.startsWith("en-"));
  if(!_voices.length) _voices=all.filter(v=>v.lang.startsWith("en"));
  if(!_voices.length) _voices=all;
  const femNames=/zira|samantha|karen|moira|tessa|victoria|allison|ava|female|woman|girl|flo|hazel|susan/i;
  _voiceFem=_voices.find(v=>femNames.test(v.name))
    || _voices.find(v=>v.name.includes("Female"))
    || _voices[0] || null;
  const malNames=/david|mark|daniel|alex|fred|jorge|rishi|guy|male|man/i;
  _voiceMal=_voices.find(v=>malNames.test(v.name) && v!==_voiceFem)
    || _voices.find(v=>v!==_voiceFem)
    || _voices[Math.min(1,_voices.length-1)] || null;
  console.log("[Voices] Female:", _voiceFem?.name, "| Male:", _voiceMal?.name,
    "| All EN:", _voices.map(v=>v.name).join(", "));
}
speechSynthesis.onvoiceschanged=loadVoices;
loadVoices();
setTimeout(loadVoices, 300);
setTimeout(loadVoices, 1000);
const FEMALE_NAMES=/^(elsa|sarah|mary|anna|emma|lily|amy|alice|kate|lisa|sue|jen|julia|linda|lucy|nancy|helen|diana|ella|grace|emily|sophie|laura|jessica|rachel|olivia|mia|chloe|zoe|hannah|natalie|victoria|iris|nora|eva|clara|ivy|ruby|pearl|violet|rose|daisy)/i;
const MALE_NAMES=/^(tim|john|peter|david|james|michael|robert|william|charles|tom|bob|sam|alex|eric|henry|george|frank|mark|paul|steve|kevin|brian|ryan|mike|chris|nick|ben|jack|dan|joe|luke|adam|jason|matt|andy|gary|neil|aaron|owen|liam|noah|ethan|leo|oscar)/i;
function getVoiceForSpeaker(speakerName) {
  if(!_voiceFem && !_voiceMal) return null;
  if(!speakerName || speakerName==="__") return _voiceFem||_voiceMal;
  if(FEMALE_NAMES.test(speakerName)) return _voiceFem||_voiceMal;
  if(MALE_NAMES.test(speakerName)) return _voiceMal||_voiceFem;
  return speakerName.charCodeAt(0)%2===0 ? (_voiceFem||_voiceMal) : (_voiceMal||_voiceFem);
}
function buildSpeakerMap() {
  const map={};let i=0;
  (lastAnalyzedData||[]).forEach(d=>{if(!d)return;const sp=d.speaker||"__";if(!(sp in map))map[sp]=i++;});
  return map;
}
let currentVolume=0.8, isMuted=false;
function setVolume(val){
  currentVolume=val/100; isMuted=false;
  const icon=document.getElementById("volIcon");
  if(icon)icon.textContent=val>50?"🔊":val>0?"🔉":"🔇";
  const s=document.getElementById("volSlider");
  if(s)s.style.background=`linear-gradient(to right,#2e86c1 ${val}%,#aed6f1 ${val}%)`;
  if(window._currentUtterance){window._currentUtterance.volume=currentVolume;}
}
function toggleMute(){
  isMuted=!isMuted;
  const icon=document.getElementById("volIcon");if(icon)icon.textContent=isMuted?"🔇":"🔊";
  const s=document.getElementById("volSlider");
  if(s){const v=isMuted?0:Math.round(currentVolume*100);s.value=v;s.style.background=`linear-gradient(to right,#2e86c1 ${v}%,#aed6f1 ${v}%)`;}
}
function applyVolume(u){u.volume=isMuted?0:currentVolume;window._currentUtterance=u;}
let currentSpeed = 1.0;
function toggleSpeedDropdown(){
  document.getElementById("speedDropdown").classList.toggle("open");
}
function setSpeed(s){
  currentSpeed = s;
  document.getElementById("speedBtn").textContent = s+"x";
  document.querySelectorAll(".ab-speed-dd div").forEach(d=>{
    d.classList.toggle("active", parseFloat(d.textContent)===s);
  });
  document.getElementById("speedDropdown").classList.remove("open");
}
function seekAudio(e){
  const pct=e.offsetX/e.currentTarget.offsetWidth;
  const sents=lastAnalyzedData.filter(Boolean);if(!sents.length)return;
  stopAudio();setTimeout(()=>playSequential(Math.max(0,Math.floor(pct*sents.length))),100);
}
function playSentence(sentence, speakerName, onEnd) {
  const u=new SpeechSynthesisUtterance(sentence);
  u.lang="en-US";u.rate=0.92*currentSpeed;
  const v=getVoiceForSpeaker(speakerName||"__");
  if(v){u.voice=v;}
  applyVolume(u);
  u.onend=onEnd||null;
  u.onerror=()=>{if(onEnd)onEnd();};
  speechSynthesis.speak(u);
}
function stopAudio() {
  speechSynthesis.cancel();
  isListeningAll=false;
  const btn=document.getElementById("btnPlay");
  if(btn)btn.innerHTML="▶";
}
function toggleCardAudio(uid, sentence, si) {
  speechSynthesis.cancel();
  if(currentPlayUid===uid){currentPlayUid=null;return;}
  currentPlayUid=uid;
  const item=lastAnalyzedData[si];
  const spName=item?item.speaker||"__":"__";
  setTimeout(()=>{
    playSentence(sentence, spName, ()=>{
      currentPlayUid=null;
      const s=getStats();
      const sec=Math.round(sentence.split(/\s+/).length/130*60);
      s.listenCount=(s.listenCount||0)+1;
      s.totalListenSec=(s.totalListenSec||0)+sec;
      saveStats(s);renderStats();
      const contentId=getCurrentHistorySupabaseId();
      if(contentId)syncListenStats(contentId, sec);
    });
  },80);
}
function toggleListenAll() {
  if(isListeningAll){stopAudio();return;}
  const sents=lastAnalyzedData.filter(Boolean);
  if(!sents.length)return;
  isListeningAll=true;
  const btn=document.getElementById("btnPlay");if(btn)btn.innerHTML="⏸";
  let i=0;
  function next(){
    if(!isListeningAll)return;
    if(i>=sents.length){
      if(isRepeat){i=0;next();return;}
      isListeningAll=false;if(btn)btn.innerHTML="▶";
      document.getElementById("abProgress").style.width="0%";
      document.getElementById("abTime").textContent=`0 / ${sents.length} câu`;
      return;
    }
    document.getElementById("abProgress").style.width=Math.round(i/sents.length*100)+"%";
    document.getElementById("abTime").textContent=`${i+1} / ${sents.length} câu`;
    const item=sents[i];
    playSentence(item.sentence, item.speaker||"__", ()=>{i++;next();});
  }
  next();
}
function restartAudio(){stopAudio();setTimeout(toggleListenAll,150);}
function toggleRepeat(){
  isRepeat=!isRepeat;
  const btn=document.getElementById("btnRepeat");
  if(btn){
    btn.style.color=isRepeat?"#2e86c1":"#1a5f8a";
    btn.innerHTML=isRepeat?"🔁<span style='font-size:9px;vertical-align:super;color:#2e86c1'>1</span>":"🔁";
  }
}
function playWordTTS(word){
  speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(word);u.lang="en-US";u.rate=0.9;
  speechSynthesis.speak(u);
}
function clickWord(word, key, lemma, meaning, level){
  playWordTTS(word);
  trackViewedWord(key, lemma, meaning, level);
}
function sentTextClick(el) {
  const card = el.closest(".sent-card");
  if (!card) return;
  const sentence = card.getAttribute("data-sentence");
  const si = parseInt(card.getAttribute("data-si")||"0");
  const uid = card.getAttribute("data-uid");
  toggleCardAudio(uid, sentence, si);
}
function sentStarClick(btnEl) {
  const card = btnEl.closest(".sent-card");
  if (!card) return;
  const sentence = card.getAttribute("data-sentence");
  const sentKey = card.getAttribute("data-sentkey");
  toggleSaveSent(sentKey, sentence, btnEl);
}
function sentAskClick(btnEl, uid) {
  const card = btnEl.closest(".sent-card");
  if (!card) return;
  const sentence = card.getAttribute("data-sentence");
  askSentAI(uid, sentence, true);
}
function toggleCard(uid){
  const body=document.getElementById("body_"+uid);
  const arrow=document.getElementById("arrow_"+uid);
  const card=document.getElementById("card_"+uid);
  if(!body)return;
  const isOpen=body.classList.contains("open");
  body.classList.toggle("open",!isOpen);
  if(card)card.classList.toggle("expanded",!isOpen);
  if(arrow)arrow.textContent=isOpen?"▶":"▼";
}
function esc(s){return String(s).replace(/\\/g,"\\\\").replace(/'/g,"\\'");}
function lvChip(lv){if(!lv)return"";const bg={A1:"#dff0d8",A2:"#d9edf7",B1:"#fcf8e3",B2:"#f2dede",C1:"#e8daef",C2:"#e8daef"}[lv]||"#eee";const cl={A1:"#3c763d",A2:"#31708f",B1:"#8a6d3b",B2:"#a94442",C1:"#6c3483",C2:"#6c3483"}[lv]||"#333";return`<span class="cefr-chip" style="background:${bg};color:${cl}">${lv}</span>`;}
// ── Common simple words for B1-B2 (always available) ─────────
const B12_COMMON={};
// ══════════════════════════════════════════════════════════════════
// MERGE chunk token_meanings → data.words (bổ sung meaning thiếu)
// ══════════════════════════════════════════════════════════════════
function mergeChunkTokenMeanings(chunks, words) {
  if (!chunks || !words) return words;
  for (const c of chunks) {
    const tm = c.token_meanings || {};
    for (const tok in tm) {
      const meaning = (tm[tok]||"").trim();
      if (!meaning || meaning === "null" || meaning === "(particle)") continue;
      const tokL = tok.toLowerCase();
      // Chỉ bổ sung nếu data.words[tok] chưa có meaning hoặc meaning sai
      const existing = words[tok] || words[tokL];
      if (!existing) {
        // Tạo entry mới minimal
        words[tok] = { meaning, level: "", type: "", grammar: "" };
      } else if (!existing.meaning || existing.meaning === "null" || existing.meaning.trim() === "") {
        existing.meaning = meaning;
      }
      // Đặc biệt: nếu existing meaning là "trên" nhưng chunk context có "vào" → override
      if (existing && existing.meaning === "trên" && meaning === "vào") {
        existing.meaning = "vào";
      }
    }
  }
  return words;
}

// ══════════════════════════════════════════════════════════════════
// POST-PROCESS DATA.CHUNKS (B1 mode)
// ══════════════════════════════════════════════════════════════════
function postProcessChunks(chunks, sentence) {
  if (!chunks || !Array.isArray(chunks)) return chunks;
  const VI_RE = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
  function isVi(s) { return VI_RE.test(s||""); }

  return chunks.map(c => {
    // A: Auto-fix text/meaning bị swap
    let text = c.text || "";
    let meaning = c.meaning || "";
    if (isVi(text) && !isVi(meaning) && meaning) {
      [text, meaning] = [meaning, text];
    }

    // B: Fix "on + day" chunk meaning
    if (/^on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(text)) {
      if (/^trên/i.test(meaning)) meaning = meaning.replace(/^trên/i, "vào");
    }

    // C: Fix "The U.S." / "The US" chunk meaning
    const textL = text.toLowerCase().trim();
    if (PROPER_NOUN_MAP[textL] && (!meaning || /^(cái|một cái|các|những|the )/.test(meaning))) {
      meaning = PROPER_NOUN_MAP[textL];
    }
    // "The U.S. carried out" — chứa proper noun + phrasal verb
    // Nếu chunk text chứa "The U.S." thì meaning không được bắt đầu bằng "cái"
    if (/^(the u\.s\.|the us|the united states)/i.test(text) && /^cái/.test(meaning)) {
      meaning = meaning.replace(/^cái\s+(Mỹ|Hoa\s*Kỳ)/i, "Hoa Kỳ");
    }

    return {...c, text, meaning};
  });
}

// ══════════════════════════════════════════════════════════════════
// TẦNG 2: Post-processing hệ thống cho B1/B2
// Chạy SAU khi nhận JSON từ API — fix các lỗi AI hay gặp
// ══════════════════════════════════════════════════════════════════

// Bảng proper nouns: lowercase key → Vietnamese meaning
const PROPER_NOUN_MAP = {
  "the u.s.":"Hoa Kỳ","the us":"Hoa Kỳ","the united states":"Hoa Kỳ","the u.s.a.":"Hoa Kỳ","the usa":"Hoa Kỳ",
  "the u.k.":"Anh Quốc","the uk":"Anh Quốc","the united kingdom":"Anh Quốc","britain":"Anh Quốc","great britain":"Anh Quốc",
  "the un":"Liên Hợp Quốc","the united nations":"Liên Hợp Quốc",
  "the eu":"Liên minh châu Âu","the european union":"Liên minh châu Âu",
  "the uae":"UAE","the u.a.e.":"UAE",
  "the nato":"NATO","nato":"NATO",
  "the who":"WHO","the imf":"IMF","the wto":"WTO",
  "the white house":"Nhà Trắng","the pentagon":"Lầu Năm Góc",
  "the kremlin":"Điện Kremlin","the g7":"G7","the g20":"G20",
  "the strait of hormuz":"eo biển Hormuz",
  "the gulf":"Vịnh Ba Tư","the persian gulf":"Vịnh Ba Tư","the gulf state":"tiểu vương quốc Vùng Vịnh",
  "iran":"Iran","iraq":"Iraq","bahrain":"Bahrain","israel":"Israel","ukraine":"Ukraine","russia":"Nga",
  "china":"Trung Quốc","japan":"Nhật Bản","south korea":"Hàn Quốc","north korea":"Triều Tiên",
};

// Bảng phrasal verbs: base form → Vietnamese meaning
// Key: lowercase infinitive form of phrasal verb
const PHRASAL_VERB_MAP = {
  "carry out":"thực hiện / tiến hành","carried out":"đã tiến hành",
  "call off":"hủy bỏ","called off":"đã hủy bỏ",
  "put forward":"đề xuất","put off":"trì hoãn",
  "set up":"thiết lập / thành lập","set off":"khởi hành / kích nổ",
  "break out":"bùng nổ","broke out":"đã bùng nổ",
  "break down":"hỏng / sụp đổ","broke down":"đã sụp đổ",
  "give up":"từ bỏ","take over":"tiếp quản","took over":"đã tiếp quản",
  "turn down":"từ chối","look forward to":"mong đợi",
  "come up with":"nghĩ ra","make up":"bịa đặt / bù đắp",
  "point out":"chỉ ra","find out":"phát hiện","found out":"đã phát hiện",
  "rule out":"loại trừ","ruled out":"đã loại trừ",
  "run out of":"cạn / hết","result in":"dẫn đến",
  "depend on":"phụ thuộc vào","rely on":"dựa vào",
  "lead to":"dẫn đến","led to":"đã dẫn đến",
  "refer to":"đề cập đến","apply to":"áp dụng cho",
  "crack down on":"trấn áp","cracked down on":"đã trấn áp",
  "take part in":"tham gia","took part in":"đã tham gia",
};

// Bảng preposition + context rules
const DAYS_OF_WEEK = new Set(["monday","tuesday","wednesday","thursday","friday","saturday","sunday",
  "thứ hai","thứ ba","thứ tư","thứ năm","thứ sáu","thứ bảy","chủ nhật"]);
const MONTHS = new Set(["january","february","march","april","may","june","july","august",
  "september","october","november","december"]);

// Các article sai khi đứng trước proper noun
const BAD_ARTICLE_MEANINGS = new Set(["cái","một cái","những","các","cái đó"]);

function postProcessB12Words(words) {
  if (!words || typeof words !== "object") return words;

  // ── Lớp A: Proper nouns ─────────────────────────────────────────
  for (const k in words) {
    const kl = k.toLowerCase().trim();

    // A1: Key là proper noun phrase → fix meaning nếu sai
    if (PROPER_NOUN_MAP[kl]) {
      const correctMeaning = PROPER_NOUN_MAP[kl];
      const curMeaning = (words[k].meaning || "").trim();
      // Chỉ override nếu meaning hiện tại sai (chứa "cái", hoặc rỗng, hoặc là tiếng Anh)
      const isBad = !curMeaning || curMeaning === "null" ||
                    BAD_ARTICLE_MEANINGS.has(curMeaning.split(" ")[0]) ||
                    /^(the|a|an)\s/i.test(curMeaning);
      if (isBad) words[k] = {...words[k], meaning: correctMeaning, type: "noun"};
    }

    // A2: token_meanings — "The/the/a/an" trước proper noun → "(mạo từ)", KHÔNG "cái"
    if (words[k].token_meanings) {
      const tm = words[k].token_meanings;
      for (const t in tm) {
        if (/^(the|a|an)$/i.test(t.trim())) {
          if (BAD_ARTICLE_MEANINGS.has((tm[t]||"").trim())) {
            tm[t] = "(mạo từ)";
          }
        }
      }
    }
  }

  // ── Lớp B: Phrasal verbs bị tách — ghép lại ────────────────────
  // Ví dụ: AI trả về key "carried" + key "out" riêng → ghép thành "carried out"
  const keys = Object.keys(words);
  const PARTICLES = new Set(["out","off","up","down","on","in","over","away","back","forward","apart","along","around","through","together","by"]);
  const toDelete = new Set();
  const toAdd = {};

  for (let i = 0; i < keys.length - 1; i++) {
    const k1 = keys[i];
    const k2 = keys[i+1];
    if (toDelete.has(k1)) continue;

    const k1l = k1.toLowerCase().trim();
    const k2l = k2.toLowerCase().trim();
    const isVerb1 = ["verb","aux","phrasal verb"].includes((words[k1].type||"").toLowerCase());
    const isParticle2 = PARTICLES.has(k2l) && (words[k2].type||"").toLowerCase() !== "verb";

    if (isVerb1 && isParticle2) {
      const combined = k1 + " " + k2;
      const combinedL = combined.toLowerCase();
      // Kiểm tra xem combined có trong PHRASAL_VERB_MAP không
      const phMeaning = PHRASAL_VERB_MAP[combinedL];
      if (phMeaning) {
        const lemmaBase = k1l.replace(/ed$/, "").replace(/ing$/, "").replace(/s$/, "");
        toAdd[combined] = {
          phrase: combined,
          meaning: phMeaning,
          lemma: combinedL.replace(/^(carried|called|set|broke|put|gave|took|found|ruled|led|cracked|took)(\s)/, (m,v,s) => {
            const map = {carried:"carry",called:"call",broke:"break",put:"put",gave:"give",took:"take",found:"find",ruled:"rule",led:"lead",cracked:"crack"};
            return (map[v]||v)+s;
          }),
          level: words[k1].level || "B1",
          type: "phrasal verb",
          grammar: words[k1].grammar || "past simple (V2)",
          token_meanings: {[k1]: words[k1].meaning||"", [k2]: "(particle)"},
          fixed_phrase: `${lemmaBase} ${k2} = phrasal verb`,
          irregular: words[k1].irregular || ""
        };
        toDelete.add(k1);
        toDelete.add(k2);
      }
    }
  }
  // Apply deletions and additions
  toDelete.forEach(k => delete words[k]);
  Object.assign(words, toAdd);

  // ── Lớp C: Preposition + context rules ─────────────────────────
  for (const k in words) {
    const kl = k.toLowerCase().trim();

    // C1: "on" + day of week → token_meanings["on"] = "vào"
    if (/^on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(k)) {
      if (words[k].token_meanings) {
        const onKey = Object.keys(words[k].token_meanings).find(t => t.toLowerCase()==="on");
        if (onKey && /^(trên|ở trên|tại trên)$/i.test((words[k].token_meanings[onKey]||"").trim())) {
          words[k].token_meanings[onKey] = "vào";
        }
        if (onKey && !words[k].token_meanings[onKey]) {
          words[k].token_meanings[onKey] = "vào";
        }
      }
      // Fix meaning nếu bắt đầu bằng "trên"
      if (words[k].meaning && /^trên\s/i.test(words[k].meaning)) {
        words[k].meaning = words[k].meaning.replace(/^trên\s/i, "vào ");
      }
      if (!words[k].fixed_phrase) {
        words[k].fixed_phrase = "on + day of week = vào (NOT trên)";
      }
    }

    // C2: Standalone "on" key được render riêng — nếu meaning là "trên" mà context là thứ
    if (kl === "on" && (words[k].meaning === "trên" || words[k].meaning === "ở trên")) {
      // Để runtime kiểm tra token context — không override vì có thể "on the table" đúng là "trên"
      // Chỉ override nếu có fixed_phrase hint
    }
  }

  return words;
}


// ══════════════════════════════════════════════════════════════════
// TẦNG 3: Validation + Auto-fix sau post-processing
// ══════════════════════════════════════════════════════════════════
function validateAndAutoFix(words, sentence) {
  if (!words || !sentence) return words;
  const sentLower = sentence.toLowerCase();

  // V1: "The" trước proper noun không được có meaning "cái/những/các"
  for (const k in words) {
    if (words[k].token_meanings) {
      const tm = words[k].token_meanings;
      for (const t in tm) {
        if (/^the$/i.test(t) && /^(cái|một cái|các|những)(\s|$)/.test(tm[t]||"")) {
          tm[t] = "(mạo từ)";
        }
      }
    }
    // V1b: Meaning của entry proper noun chứa "cái ..." → remove "cái"
    const kl = k.toLowerCase();
    if (PROPER_NOUN_MAP[kl] && (words[k].meaning||"").startsWith("cái ")) {
      words[k].meaning = words[k].meaning.replace(/^cái\s+/,"");
    }
  }

  // V2: Phrasal verb check — quét toàn bộ keys, nếu thấy pattern "verb + particle" liền nhau trong sentence → merge
  const keyList = Object.keys(words);
  const COMMON_PHRASAL = [
    ["carried","out"],["carry","out"],["called","off"],["call","off"],
    ["set","up"],["broke","out"],["break","out"],["turned","down"],["turn","down"],
    ["gave","up"],["give","up"],["found","out"],["find","out"],
    ["ruled","out"],["rule","out"],["led","to"],["lead","to"],
    ["took","over"],["take","over"],["put","forward"],["put","off"],
    ["came","up"],["come","up"],["went","on"],["go","on"],
    ["pointed","out"],["point","out"],["cracked","down"],["crack","down"],
  ];

  for (const [v, p] of COMMON_PHRASAL) {
    const hasVerb = keyList.find(k => k.toLowerCase().trim() === v);
    const hasParticle = keyList.find(k => k.toLowerCase().trim() === p);
    // Kiểm tra chúng liền nhau trong sentence
    if (hasVerb && hasParticle) {
      const vIdx = sentLower.indexOf(v);
      const pIdx = sentLower.indexOf(p, vIdx + v.length);
      if (pIdx > 0 && pIdx - vIdx - v.length <= 1) {
        // Chúng liền nhau → merge
        const combined = hasVerb + " " + hasParticle;
        const pMeaning = PHRASAL_VERB_MAP[combined.toLowerCase()] ||
                         PHRASAL_VERB_MAP[v + " " + p] || "";
        if (pMeaning) {
          words[combined] = {
            phrase: combined,
            meaning: pMeaning,
            lemma: v.replace(/ed$/,"").replace(/ing$/,"") + " " + p,
            level: words[hasVerb]?.level || "B1",
            type: "phrasal verb",
            grammar: words[hasVerb]?.grammar || "verb phrase",
            token_meanings: {[hasVerb]: words[hasVerb]?.meaning||"", [hasParticle]: "(particle)"},
            fixed_phrase: `${v.replace(/ed$/,"").replace(/ing$/,"")} ${p} = phrasal verb`,
            irregular: words[hasVerb]?.irregular || ""
          };
          delete words[hasVerb];
          delete words[hasParticle];
        }
      }
    }
  }

  // V3: "on + day" meaning — bất kỳ entry nào có "on" trong token_meanings
  // mà next token là weekday thì meaning của "on" phải là "vào"
  for (const k in words) {
    const kl = k.toLowerCase();
    if (/\bon\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i.test(k)) {
      if (words[k].token_meanings) {
        for (const t in words[k].token_meanings) {
          if (t.toLowerCase()==="on" && /^(trên|ở\s+trên|tại\s+trên)$/i.test(words[k].token_meanings[t]||"")) {
            words[k].token_meanings[t] = "vào";
          }
        }
      }
      if ((words[k].meaning||"").match(/^trên\s+thứ/i)) {
        words[k].meaning = words[k].meaning.replace(/^trên\s+thứ/i, "vào thứ");
      }
    }
  }

  return words;
}

// ── Post-process B1-B2 API data ──────────────────────────────
// Auto-group aux+verb chains, passive, phrasal verbs that API left separate
// ── Build B1-B2 card ──────────────────────────────────────────
function buildB12Html(sentence, data, uid, si) {
  const s = getStats();
  const saved = new Set((s.savedWordsList||[]).map(w=>w.key));
  // Tokenize: keep contractions (we're), possessives (Trump's), hyphens (14-point)
  // Splits on spaces and pure punctuation; keeps word+'word and word-word
  const _norm = sentence
    .replace(/[\u2018\u2019\u02BC]/g, "'")   // smart apostrophe → ASCII
    .replace(/[\u201C\u201D\u00AB\u00BB]/g, '"') // smart quotes → ASCII
    // Normalize dotted abbreviations: U.S. → US, U.K. → UK, U.N. → UN, U.S.A. → USA
    .replace(/\b([A-Z])\.([A-Z])\.([A-Z])\./g, "$1$2$3")  // U.S.A. → USA
    .replace(/\b([A-Z])\.([A-Z])\./g, "$1$2")              // U.S. → US, U.K. → UK
    .replace(/\b([A-Z])\.\s/g, "$1 ");                     // trailing "U. " → "U "
  // Match: numbers+hyphens, words+contractions+hyphens, OR single punctuation chars
  const cleanTokens = _norm.match(/\$?\d[\d,]*(?:\.\d+)?(?:[kKmMbBtT%](?!\w))?(?:[\-]\w+)*|[a-zA-Z\u00C0-\u024F]+(?:'[a-zA-Z]+)*(?:-[a-zA-Z\u00C0-\u024F]+)*|[.,!?;:"'()\-–—""'']/g) || [];
  // Common words that should ALWAYS come from B12_COMMON, never from phrase matching
  // ALWAYS_COMMON: words that should NEVER match phrase entries
  // Removed: to, with, for, in, on, at, by — these can appear in specific phrases
  // Kept: pure function words that never have context-specific meanings
  const ALWAYS_COMMON = new Set(["the","a","an","i",
    "and","but","or","so","not","no",
    "is","are","was","were","be","been",
    "have","has","had","do","does","did","will","would","could","should","may","might",
    "its","her","his","their","our","my","your",
    "this","that","it","they","we","she","he","you",
    "who","which","what","when","where","how"]);
  // words lookup — used by findInfo below
  const words = data.words || {};
  const _sentCache = {};
  // ── Fix: "US" as proper noun (not pronoun "us") ──
  // If token is "US" (uppercase) and not in data.words, treat as "United States"
  // Similarly UK, UN, EU, UAE, NATO, etc.
  const COUNTRY_ABBR = {
    "US":"Hoa Kỳ", "USA":"Hoa Kỳ", "UK":"Anh Quốc", "UN":"Liên Hợp Quốc",
    "EU":"Liên minh châu Âu", "UAE":"UAE", "NATO":"NATO", "WHO":"WHO",
    "IMF":"IMF", "GDP":"GDP", "CEO":"CEO", "AI":"AI"
  };
  function findInfo(token) {
    const tl = token.toLowerCase();
    // 0. Proper noun abbreviation override — "US" must NOT map to pronoun "us"
    if (COUNTRY_ABBR[token]) {
      // Check data.words first (AI may have provided context-specific entry)
      if (words[token]) return {key:token, info:words[token]};
      // Return built-in meaning
      return {key:token, info:{meaning:COUNTRY_ABBR[token], level:"B1", type:"noun", phrase: words["the "+tl] ? "the "+token : (words["the "+token] ? "the "+token : "")}};
    }
    // 1. For AUXILIARIES: check data.words first (they may be part of "has replied", "was deleted")
    // For other common words: go straight to B12_COMMON
    const AUX_SET = new Set(["is","are","was","were","be","been","have","has","had",
      "do","does","did","will","would","could","should","may","might","being"]);
    if (ALWAYS_COMMON.has(tl) && !AUX_SET.has(tl)) {
      // Check data.words first — common word may be part of a phrase
      if (words[tl]) return {key:tl, info:words[tl]};
      if (B12_COMMON[tl]) return {key:tl, info:B12_COMMON[tl]};
      return null;
    }
    // Auxiliaries: try data.words first (may be grouped as "has replied" etc.)
    if (AUX_SET.has(tl)) {
      if (words[tl]) return {key:tl, info:words[tl]};
      // Check token_meanings — aux may be inside a phrase entry
      for (const k in words) {
        const info = words[k];
        if (info.token_meanings && (info.token_meanings[token] !== undefined || info.token_meanings[tl] !== undefined)) {
          const tm = info.token_meanings[token] ?? info.token_meanings[tl];
          return {key:k, info, tokMeaningOverride: tm};
        }
      }
      // Check if any key starts with this aux
      for (const k in words) {
        if (k.toLowerCase().startsWith(tl + " ")) return {key:k, info:words[k]};
      }
      // Fallback to B12_COMMON
      if (B12_COMMON[tl]) return {key:tl, info:B12_COMMON[tl]};
      return null;
    }
    // 2. Possessive: "Trump's" → try "Trump" (strip 's or s')
    if (token.includes("'")) {
      const base = token.replace(/'s$|s'$|'re$|'ve$|'ll$|'d$|n't$/, "").toLowerCase();
      const suffix = token.replace(base,"").toLowerCase();
      if (base && base !== tl) {
        const found = findInfo(base);
        if (found) return {key:found.key, info:{...found.info,
          possessive: suffix==="'s" || suffix==="s'",
          contraction: suffix!=="'s" && suffix!=="s'"
        }};
      }
    }
    if (words[token]) return {key:token, info:words[token]};
    if (words[tl])    return {key:tl,    info:words[tl]};
    for (const k in words) {
      if (k.toLowerCase() === tl) return {key:k, info:words[k]};
    }
    for (const k in words) {
      const info = words[k];
      if (info.token_meanings) {
        if (info.token_meanings[token] !== undefined)
          return {key:k, info, tokMeaningOverride: info.token_meanings[token]};
        if (info.token_meanings[tl] !== undefined)
          return {key:k, info, tokMeaningOverride: info.token_meanings[tl]};
      }
    }
    const SKIP_PARTIAL = new Set(["with","for","in","by","of","on","at",
      "from","about","through","between","against","around","within","toward"]);
    if (!SKIP_PARTIAL.has(tl)) {
      for (const k in words) {
        const kl = k.toLowerCase();
        if (!SKIP_PARTIAL.has(tl) && !/^[A-Z]/.test(token)) {
          if (kl.startsWith(tl + " ") || kl.endsWith(" " + tl)) return {key:k, info:words[k]};
        }
      }
    }
    if (/^[A-Z]/.test(token)) {
      for (const k in words) {
        const kl = k.toLowerCase();
        if (kl.startsWith(tl + " ") || kl.endsWith(" " + tl) || kl === tl) {
          return {key:k, info:words[k]};
        }
      }
    }
    if (_sentCache[token]) return {key:token, info:_sentCache[token]};
    if (_sentCache[tl])    return {key:tl,    info:_sentCache[tl]};
    if (B12_COMMON[tl]) return {key:tl, info:B12_COMMON[tl]};
    for(const k in words){
      const wl=(words[k].lemma||"").toLowerCase();
      if(wl===tl) return {key:k, info:words[k]};
    }
    const stems=[tl.replace(/ed$/,""),tl.replace(/ing$/,""),tl.replace(/s$/,""),
                 tl.replace(/ies$/,"y"),tl.replace(/ied$/,"y"),tl.replace(/er$/,""),
                 tl.replace(/ly$/,""),tl.replace(/ness$/,""),tl.replace(/ment$/,"")
                ].filter(s=>s&&s!==tl&&s.length>=3);
    for(const stem of stems){
      if(words[stem]) return {key:stem,info:{...words[stem],lemma:words[stem].lemma||stem}};
      for(const k in words){
        if((words[k].lemma||"").toLowerCase()===stem) return {key:k,info:words[k]};
      }
      if(B12_COMMON[stem]) return {key:stem,info:{...B12_COMMON[stem],lemma:B12_COMMON[stem].lemma||stem}};
    }
    const reWB = new RegExp("(?:^|[\\s\\-])"+tl.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?:[\\s\\-]|$)");
    for(const k in words){ if(reWB.test(k.toLowerCase())) return {key:k,info:words[k]}; }
    const isProper = /^[A-Z]/.test(token);
    let guessType = "noun";
    if(/ly$/.test(tl)) guessType="adverb";
    else if(/ing$/.test(tl)) guessType="verb";
    else if(/ed$/.test(tl)) guessType="verb";
    else if(/tion$|ment$|ness$|ity$|ance$|ence$/.test(tl)) guessType="noun";
    else if(/ful$|less$|able$|ible$|ous$|ive$|al$/.test(tl)) guessType="adjective";
    const stubMeaning = isProper ? "danh từ riêng" : "";
    const stubLevel = isProper ? "" : "";
    return {key:tl, info:{meaning:stubMeaning, level:stubLevel, type:guessType, _noAPI:true}};
  }
  let wordsHtml = "";
  for (const token of cleanTokens) {
    if (/^[.,!?;:)\-–—]$/.test(token)) {
      // No space before punctuation — remove trailing space from previous token
      if(wordsHtml.endsWith(' ')) wordsHtml=wordsHtml.slice(0,-1);
      wordsHtml += `<span class="b12-punct">${token}</span> `;
      continue;
    }
    if (/^["'(]$/.test(token)) {
      wordsHtml += `<span class="b12-punct">${token}</span>`;
      continue;
    }
    const found = findInfo(token);
    if (!found) {
      // console.log("[findInfo miss]", token);
      wordsHtml += `<span class="b12-word"
data-key="" data-token="${esc(token)}" data-phrase=""
data-lemma="" data-meaning="" data-tok-meaning=""
data-level="" data-uid="${uid}"
onmouseenter="b12HoverShow(this,event)"
onmouseleave="b12HoverHide(this)"
onclick="b12WordClick(this,event)"
>${token}</span> `;
      continue;
    }
    const {key, info, tokMeaningOverride} = found;
    const isSaved = saved.has(`${key}_${info.lemma||key}`);
    const wkey = esc(`${key}_${info.lemma||key}`);
    const wlemma = esc(info.lemma||key);
    const wmeaning = esc(info.meaning||"");
    const wlevel = info.level||"";
    // Level chip color
    const lvBg = {A1:"#3c763d",A2:"#31708f",B1:"#8a6d3b",B2:"#a94442",C1:"#6c3483",C2:"#6c3483"}[wlevel]||"#888";
    const wtoken = esc(token);
    const wphrase = esc(info.phrase||"");
    // token_meaning: use override from findInfo, then token_meanings map, then ""
    const rawTokMeaning = tokMeaningOverride !== undefined ? tokMeaningOverride
      : (info.token_meanings?.[token] ?? info.token_meanings?.[token.toLowerCase()] ?? "");
    const wtokMeaning = esc(rawTokMeaning);
    wordsHtml += `<span class="b12-word ${isSaved?"b12-saved":""}"
data-key="${wkey}" data-token="${wtoken}" data-phrase="${wphrase}"
data-lemma="${wlemma}" data-meaning="${wmeaning}"
data-tok-meaning="${wtokMeaning}"
data-level="${wlevel}" data-uid="${uid}"
onmouseenter="b12HoverShow(this,event)"
onmouseleave="b12HoverHide(this)"
onclick="b12WordClick(this,event)"
>${token}</span> `;
  }
  // Translation — strip wrapping parentheses if present
  const rawTrans = (data.sentence||"—").trim().replace(/^\((.+)\)$/, "$1");
  const transHtml = `<div class="translation" style="margin-bottom:8px">
<span class="translation-text">${rawTrans}</span>
</div>`;
  // AI explain box
  const aiHtml = `<div id="aiSent_${uid}" style="display:none" class="ai-explain-box"></div>`;
  // Sentence analysis (shown first, plain text is toggle)
  return `<div id="b12body_${uid}" data-sentence="${sentence.replace(/"/g,"&quot;")}">
<div class="b12-sent" id="b12sent_${uid}" data-mode="analysis">${wordsHtml}</div>
${transHtml}
${aiHtml}
</div>`;
}
// ── B1-B2 word interaction ────────────────────────────────────
let b12ActiveTooltip = null;
let b12ActiveWord = null;
// ── Hover (preview) ──────────────────────────────────────────
let b12HoverTimer = null;
function b12HoverShow(el, evt) {
  // Don't show hover preview if tooltip is already pinned to this word
  if (b12ActiveWord === el) return;
  // Show tooltip in "preview" (unpinned) mode
  if (b12HoverTimer) clearTimeout(b12HoverTimer);
  b12HoverTimer = setTimeout(() => {
    if (b12ActiveWord) return; // already pinned
    b12CloseHover();
    b12ShowTooltipMode(el, false); // false = hover mode
  }, 80);
}
function b12HoverHide(el) {
  if (b12HoverTimer) { clearTimeout(b12HoverTimer); b12HoverTimer = null; }
  // Delay hide so user can move mouse into tooltip
  b12HoverTimer = setTimeout(() => {
    if (!b12IsHoveringTooltip) b12CloseHover();
    b12HoverTimer = null;
  }, 200);
}
let b12HoverTooltip = null;
let b12IsHoveringTooltip = false;
function b12CloseHover() {
  if (b12HoverTooltip) { b12HoverTooltip.remove(); b12HoverTooltip = null; }
}
function b12WordClick(el, evt) {
  evt.stopPropagation();
  // Close hover preview
  b12CloseHover();
  if (b12HoverTimer) { clearTimeout(b12HoverTimer); b12HoverTimer = null; }
  const key        = el.getAttribute("data-key");
  const lemma      = el.getAttribute("data-lemma");
  const meaning    = el.getAttribute("data-meaning");
  const tokMeaning = el.getAttribute("data-tok-meaning") || "";
  const level      = el.getAttribute("data-level");
  const uid        = el.getAttribute("data-uid");
  const token2     = el.getAttribute("data-token") || el.textContent.trim();
  // Track viewed with best available meaning
  if (key) trackViewedWord(key, lemma||token2, tokMeaning||meaning, level);
  // Toggle pinned tooltip
  if (b12ActiveWord === el) {
    b12CloseTooltip();
    return;
  }
  b12CloseTooltip();
  b12ActiveWord = el;
  el.classList.add("active");
  b12ShowTooltipMode(el, true); // true = pinned mode
}
function b12ShowTooltipMode(el, pinned) {
  const key        = el.getAttribute("data-key");
  const token      = el.getAttribute("data-token") || el.textContent.trim();
  const lemma      = el.getAttribute("data-lemma");
  const meaning    = el.getAttribute("data-meaning");
  const tokMeaning = el.getAttribute("data-tok-meaning") || "";
  const level      = el.getAttribute("data-level");
  const phraseAttr = el.getAttribute("data-phrase") || "";
  const uid        = el.getAttribute("data-uid");
  let info         = b12GetWordData(uid, key);
  // If info has no phrase but span has data-phrase, inject it
  if (info && !info.phrase && phraseAttr && phraseAttr !== token) {
    info = {...info, phrase: phraseAttr};
  }
  // If info is null but we have basic data from span, create minimal info
  if (!info && (meaning || level)) {
    info = {meaning, level, type: null, phrase: phraseAttr||null};
  }
  // If still no info, build minimal info so tooltip always shows full layout
  if (!info) {
    const isProper = /^[A-Z]/.test(token);
    info = isProper
      ? {meaning:"danh từ riêng", level:"", type:"noun", grammar:null}
      : {meaning:"", level:"", type:"noun", grammar:null};
  }
  b12ShowTooltip(el, token, key, lemma, meaning, tokMeaning, level, info, uid, pinned);
}
function b12GetWordData(uid, key) {
  const si = parseInt(uid.replace("s",""))||0;
  const item = lastAnalyzedData[si];
  if (!item) return null;
  const words = item.data?.words||{};
  // Strip _lemma suffix
  const baseKey = key.includes("_") ? key.split("_")[0] : key;
  const bkl = baseKey.toLowerCase();
  // 1. Direct match
  for (const sk of [key, baseKey, bkl]) {
    if (words[sk]) return words[sk];
  }
  // 2. Case-insensitive key match
  for (const k in words) {
    if (k.toLowerCase() === bkl) return words[k];
  }
  // 3. token_meanings match — token is a member of a phrase entry
  for (const k in words) {
    const info = words[k];
    if (info.token_meanings && (info.token_meanings[baseKey] !== undefined || info.token_meanings[bkl] !== undefined)) {
      return info;
    }
  }
  // 4. Key starts or ends with token
  for (const k in words) {
    const kl = k.toLowerCase();
    if (kl.startsWith(bkl + " ") || kl.endsWith(" " + bkl)) return words[k];
  }
  // 5. phrase field contains token
  for (const k in words) {
    const ph = (words[k].phrase||k).toLowerCase().replace(/\.\.\./, " ");
    if (ph.split(/\s+/).filter(Boolean).includes(bkl)) return words[k];
  }
  // 6. lemma field match
  for (const k in words) {
    if ((words[k].lemma||"").toLowerCase() === bkl) return words[k];
  }
  // 7. Stem match: strip suffix then retry
  const stems = [bkl.replace(/ed$/,""),bkl.replace(/ing$/,""),bkl.replace(/s$/,""),
                 bkl.replace(/ies$/,"y"),bkl.replace(/ied$/,"y")
                ].filter(s=>s&&s!==bkl&&s.length>=3);
  for (const stem of stems) {
    if (words[stem]) return words[stem];
    for (const k in words) {
      if (k.toLowerCase()===stem || (words[k].lemma||"").toLowerCase()===stem) return words[k];
    }
  }
  // 8. Token as whole word within key (handles "candidates" in "Mamdani-backed candidates")
  const reWB = new RegExp("(?:^|[\\s\\-])"+bkl.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?:[\\s\\-]|$)");
  for (const k in words) { if (reWB.test(k.toLowerCase())) return words[k]; }
  return null;
}
// ── Grammar abbreviation helper ─────────────────────────────
// Comprehensive irregular verb tables for accurate V2/V3 detection
const IRREG_V2 = new Set(["arose","awoke","was","were","beat","became","began","bent","bet","bit","bled","blew","broke","bred","brought","broadcast","built","burnt","bought","caught","chose","came","cost","crept","cut","dealt","dug","dove","drew","drank","drove","ate","fell","fed","felt","fought","found","flew","forbade","forgot","forgave","froze","got","gave","went","grew","hung","had","heard","hid","hit","held","hurt","kept","knelt","knew","laid","led","leant","leapt","learnt","left","lent","let","lay","lit","lost","made","meant","met","paid","pled","proved","put","quit","read","rode","rang","rose","ran","said","saw","sold","sent","set","shook","shone","shot","showed","shrunk","shut","sang","sank","sat","slept","slid","smelt","spoke","sped","spent","spun","spread","stood","stole","stuck","stung","stank","struck","swam","swung","took","taught","tore","told","thought","threw","understood","woke","wore","won","withdrew","wrote","burnt","dreamt","spelt","leapt","dwelt","swept","wept"]);
const IRREG_V3 = new Set(["arisen","awoken","beaten","become","begun","bent","bet","bitten","bled","blown","broken","bred","brought","broadcast","built","burnt","bought","caught","chosen","come","cost","crept","cut","dealt","dug","done","drawn","drunk","driven","eaten","fallen","fed","felt","fought","found","flown","forbidden","forgotten","forgiven","frozen","got","gotten","given","gone","grown","hung","had","heard","hidden","hit","held","hurt","kept","knelt","known","laid","led","lain","left","lent","let","lit","lost","made","meant","met","paid","put","quit","read","ridden","rung","risen","run","said","seen","sold","sent","set","shaken","shone","shot","shown","shrunk","shut","sung","sunk","sat","slept","slid","smelt","spoken","sped","spent","spun","spread","stood","stolen","stuck","stung","struck","swum","swung","taken","taught","torn","told","thought","thrown","understood","woken","worn","won","withdrawn","written","burnt","dreamt","spelt","leapt","wept","swept","knelt","crept"]);

function gramAbbr(type, grammar, lemma, token) {
  const tl = (token||"").toLowerCase();
  const ll = (lemma||"").toLowerCase();
  const gl = (grammar||"").toLowerCase();
  const ty = (type||"").toLowerCase();
  const typeMap = {
    "noun":"noun","verb":"verb","adjective":"adj","adverb":"adv",
    "preposition":"prep","conjunction":"conj","pronoun":"pron",
    "article":"art","auxiliary":"aux","interjection":"interj",
    "phrasal verb":"phrasal verb","phrase":"phrase",
    "collocation":"phrase","idiom":"phrase",
    "noun/adjective":"noun / adj","noun/adj":"noun / adj"
  };
  const tAbbr = typeMap[ty] || (type && type !== "null" ? type : "") || "";
  // Verb form detection — improved with irregular verb tables + grammar hints
  let formTag = "";
  if (tAbbr==="verb"||tAbbr==="aux"||tAbbr==="phrasal verb") {
    if (gl.includes("v3")||gl.includes("past part")||gl.includes("particip")||gl.includes("passive")) {
      formTag = "V3";
    } else if (gl.includes("v-ing")||gl.includes("gerund")||gl.includes("present particip")||(tl.endsWith("ing") && tl!==ll)) {
      formTag = "V-ing";
    } else if (gl.includes("v2")||gl.includes("past simple")||gl.includes("simple past")||(gl.includes("past")&&!gl.includes("particip"))) {
      formTag = "V2";
    } else if (tl && ll && tl !== ll) {
      if (tl.endsWith("ing")) formTag = "V-ing";
      else if (IRREG_V3.has(tl)) formTag = "V3";
      else if (IRREG_V2.has(tl)) formTag = "V2";
      else if (tl.endsWith("ed")) formTag = (gl.includes("particip")||gl.includes("passive")) ? "V3" : "V2";
      else if (tl.endsWith("s") && !ll.endsWith("s")) formTag = "V-s";
    }
  }
  // Grammar tense — extract most useful part
  let gTag = "";
  if (gl) {
    if (gl.includes("past perf")&&gl.includes("cont"))              gTag="past perf. cont.";
    else if (gl.includes("pres")&&gl.includes("perf")&&gl.includes("cont")) gTag="pres. perf. cont.";
    else if (gl.includes("future")&&gl.includes("cont"))             gTag="future cont.";
    else if (gl.includes("future")&&gl.includes("perf"))             gTag="future perf.";
    else if (gl.includes("past perf")||gl.includes("past perfect"))  gTag="past perf.";
    else if (gl.includes("pres")&&gl.includes("perf"))               gTag="pres. perf.";
    else if (gl.includes("past")&&gl.includes("cont"))               gTag="past cont.";
    else if (gl.includes("pres")&&gl.includes("cont"))               gTag="pres. cont.";
    else if (gl.includes("simple past")||gl.includes("past simple")) gTag="past simple";
    else if (gl.includes("simple present")||gl.includes("present simple")) gTag="pres. simple";
    else if (gl.includes("passive"))   gTag="passive";
    else if (gl.includes("future"))    gTag="future";
    else if (gl.includes("modal"))     gTag="modal";
    else if (gl.includes("base")||gl.includes("infinitive")) gTag="base form";
    else if (gl.includes("inf"))       gTag="inf.";
    else if (gl.includes("question"))  gTag="question";
    else if (gl.includes("negative"))  gTag="negative";
    else if (gl.includes("gerund"))    gTag="gerund";
    else if (grammar && grammar.length <= 28) gTag=grammar;
  }
  const parts = [];
  if (tAbbr) parts.push(tAbbr);
  if (formTag) parts.push(formTag);
  if (gTag && gTag !== tAbbr) parts.push(gTag);
  return parts.join(" · ");
}
function b12ShowTooltip(wordEl, token, key, lemma, meaning, tokMeaning, level, info, uid, pinned) {
  const tt = document.createElement("div");
  tt.className = "b12-tooltip";
  tt.id = "b12tt_current";
  const s = getStats();
  const isSaved = (s.savedWordsList||[]).some(w=>w.key===key);
  const lvBg = {A1:"#3c763d",A2:"#31708f",B1:"#8a6d3b",B2:"#a94442",C1:"#6c3483",C2:"#6c3483"}[level]||"#555";
  // No data: build a proper tooltip instead of just "(Nhấn vào từ để nghe phát âm)"
  if (!info && !meaning && !key) {
    // Detect if proper noun (starts with capital, not sentence-start)
    const isProperNoun = /^[A-Z]/.test(token);
    const noDataInfo = isProperNoun
      ? {meaning:"danh từ riêng", level:"", type:"noun", grammar:null}
      : {meaning:"", level:"", type:"noun", grammar:null};
    // Recurse with minimal info so full tooltip renders
    b12ShowTooltip(wordEl, token, token.toLowerCase(), null, noDataInfo.meaning, "", noDataInfo.level, noDataInfo, uid, pinned);
    return;
  }
  // isSimple: interjection, or A1 article/pronoun with no grammar
  const ty2 = (info?.type||"").toLowerCase();
  const isSimple = ty2 === "interjection" ||
    ((ty2 === "article" || ty2 === "pronoun") && (info?.level === "A1-A2") && !info?.grammar);
  // TỪ ĐI CHUNG — only for genuine short phrases, not sentence fragments
  const rawPhrase = (info?.phrase && info.phrase !== "null") ? info.phrase : "";
  const phraseWC = rawPhrase.replace(/\.\.\./, " ").trim().split(/\s+/).filter(Boolean).length;
  const phraseDisplay = (rawPhrase &&
    rawPhrase.toLowerCase() !== token.toLowerCase() &&
    phraseWC >= 2 && phraseWC <= 8) ? rawPhrase : null;
  // Show ← lemma when it differs from both token AND key base
  const keyBase2 = (key||"").split("_")[0].toLowerCase();
  const lemmaDisplay = lemma &&
    lemma.toLowerCase() !== token.toLowerCase() &&
    lemma.toLowerCase() !== keyBase2 ? lemma : null;
  // THÔNG TIN — abbreviation line
  // Always compute abbr; isSimple just means grammar part is simpler
  const abbr = gramAbbr(info?.type, isSimple ? null : info?.grammar, lemma||keyBase, token);
  // Build sections
  let sectHtml = "";
  // 1. TỪ ĐI CHUNG (with 🔊 to read the phrase)
  if (phraseDisplay) {
    sectHtml += `<div class="b12-tt-section">
      <div class="b12-tt-label">TỪ ĐI CHUNG</div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-style:italic;color:#5dade2;font-size:13px;flex:1">${phraseDisplay}</span>
        <button data-tts="${phraseDisplay.replace(/"/g,'&quot;')}" onclick="event.stopPropagation();speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(this.dataset.tts);u.lang='en-US';speechSynthesis.speak(u);"
          style="background:rgba(93,173,226,.2);border:none;cursor:pointer;color:#5dade2;font-size:12px;padding:2px 6px;border-radius:4px;flex-shrink:0" title="Nghe cụm">🔊 cụm</button>
      </div>
    </div>`;
  }
  // Display meaning: use token-specific meaning if available, else phrase meaning
  const _noAPI = info?._noAPI === true;
  const _rawMeaning = tokMeaning || meaning || info?.meaning || "";
  if (!window._b12MeanCache) window._b12MeanCache = {};
  const _cached = window._b12MeanCache[token.toLowerCase()];
  const needsAutoFetch = false;
  const displayMeaning = _cached ? _cached.meaning
    : _rawMeaning ? _rawMeaning
    : "—";
  // refers_to for pronouns (this/her/it etc)
  const refersTo = (info?.refers_to && info.refers_to !== "null") ? info.refers_to : null;
  // Word type label in Vietnamese
  const typeMap = {
    "noun":"danh từ","verb":"động từ","adjective":"tính từ","adverb":"trạng từ",
    "pronoun":"đại từ","preposition":"giới từ","conjunction":"liên từ",
    "article":"mạo từ","auxiliary":"trợ động từ","phrasal verb":"phrasal verb",
    "phrase":"cụm từ","noun/adjective":"danh/tính từ"
  };
  const typeLabel = info?.type ? (typeMap[info.type.toLowerCase()] || info.type) : "";
  // 2. NGHĨA — bold meaning, ← lemma on same line
  sectHtml += `<div class="b12-tt-section">
    <div class="b12-tt-label">NGHĨA</div>
    <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
      <span style="font-weight:bold;font-size:14px;color:#fff">${displayMeaning}</span>
      ${(lemmaDisplay && lemmaDisplay !== "null") ? `<span style="font-size:11px;color:#aed6f1">← ${lemmaDisplay}</span>` : ""}
    </div>
    ${abbr ? `<div style="margin-top:4px;font-size:11px;color:#aed6f1;letter-spacing:.3px">${abbr}</div>` : ""}
    ${refersTo ? `<div style="margin-top:3px;font-size:11px;color:#5dade2">→ ${refersTo}</div>` : ""}
    <div class="b12-tt-meta" style="margin-top:4px;display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      ${level ? `<span class="b12-tt-chip" style="background:${lvBg}">${level}</span>` : ""}
      ${typeLabel ? `<span style="font-size:11px;color:#aed6f1;font-style:italic">${typeLabel}</span>` : ""}
    </div>
  </div>`;
  // AI box
  sectHtml += `<div id="b12tt_ai" class="b12-tt-ai-box" style="display:none"></div>`;
  // For possessives like "Trump's", show token as-is in header
  tt.innerHTML = `
    <div class="b12-tt-header">
      <span class="b12-tt-word">${token}</span>
      <div class="b12-tt-actions">
        <button class="b12-tt-btn" onclick="b12TTSpeak('${esc(token)}')" title="Nghe từ trong câu">🔊</button>
        <button class="b12-tt-btn ${isSaved?"saved":""}" id="b12tt_star"
          onclick="b12TTStar('${esc(key)}','${esc(lemma||key)}','${esc(meaning||"")}','${level||""}')"
          title="Lưu từ">${isSaved?"🌟":"☆"}</button>
        <button class="b12-tt-btn" onclick="b12TTAskAI('${esc(key)}','${uid}')" title="Hỏi AI">💬</button>
        <button class="b12-tt-btn b12-tt-close" onclick="b12CloseTooltip()" title="Đóng" style="display:none">✕</button>
      </div>
    </div>
    ${sectHtml}`;
  document.body.appendChild(tt);
  if (pinned) {
    b12ActiveTooltip = tt;
    // Close on outside click
    setTimeout(()=>{
      document.addEventListener("click", b12OutsideClose, {once:true, capture:true});
    }, 50);
  } else {
    b12HoverTooltip = tt;
    // Mouse enter/leave on tooltip itself
    tt.addEventListener("mouseenter", () => { b12IsHoveringTooltip = true; });
    tt.addEventListener("mouseleave", () => {
      b12IsHoveringTooltip = false;
      b12CloseHover();
    });
  }
  // Show close button only for pinned
  const closeBtn = tt.querySelector(".b12-tt-close");
  if (closeBtn) closeBtn.style.display = pinned ? "flex" : "none";
  // Smart positioning
  b12PositionTooltip(tt, wordEl);
}
function b12PositionTooltip(tt, wordEl) {
  // Use actual rendered size
  tt.style.visibility = "hidden";
  tt.style.display = "block";
  const ttRect = tt.getBoundingClientRect();
  const ttW = ttRect.width || 260;
  const ttH = ttRect.height || 200;
  tt.style.visibility = "";
  const rect = wordEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const GAP = 6; // px gap between word and tooltip
  // Horizontal: align left edge with word, clamp
  let left = rect.left;
  if (left + ttW > vw - 8) left = vw - ttW - 8;
  if (left < 8) left = 8;
  // Vertical: prefer just above word, else just below
  let top;
  if (rect.top - ttH - GAP >= 8) {
    top = rect.top - ttH - GAP;
  } else {
    top = rect.bottom + GAP;
  }
  if (top + ttH > vh - 8) top = vh - ttH - 8;
  if (top < 8) top = 8;
  tt.style.left = left + "px";
  tt.style.top = top + "px";
}
function b12OutsideClose(e) {
  if (!e.target.closest(".b12-tooltip") && !e.target.closest(".b12-word")) {
    b12CloseTooltip();
  }
}
function b12CloseTooltip() {
  if (b12ActiveTooltip) { b12ActiveTooltip.remove(); b12ActiveTooltip = null; }
  if (b12ActiveWord) { b12ActiveWord.classList.remove("active"); b12ActiveWord = null; }
  document.removeEventListener("click", b12OutsideClose, true);
}
function b12TTSpeak(word) {
  playWordTTS(word);
}
function b12TTStar(key, lemma, meaning, level) {
  const btn = document.getElementById("b12tt_star");
  toggleSaveWord(key, lemma, meaning, level, btn);
}
async function b12TTAskAI(word, uid) {
  const box = document.getElementById("b12tt_ai");
  if (!box) return;
  if (box.style.display === "block") { box.style.display = "none"; return; }
  const used = getAIUsed();
  if (used >= AI_LIMIT) {
    box.style.display = "block";
    box.innerHTML = `<span style="color:#f5a623;font-size:11px">⚠ Hết ${AI_LIMIT} lần AI hôm nay.</span>`;
    return;
  }
  box.style.display = "block";
  box.innerHTML = "⏳ ...";
  let tip = AI_WORD_TIPS[word] || null;
  // Get sentence context
  const si = parseInt((uid||"s0").replace("s",""))||0;
  const sentCtx = lastAnalyzedData[si]?.sentence || "";
  if(!tip) {
    try {
      tip = await callWorker("word_tip", { word, sentenceContext: sentCtx });
    } catch(e){}
  }
  if(!tip) tip=`Từ "<b>${word}</b>". Không thể lấy giải thích lúc này, thử lại sau.`;
  box.innerHTML = `<span style="font-size:11px;color:#5dade2">Còn ${AI_LIMIT-used-1} lần</span><br>${tip}`;
  incAIUsed();
  if (b12ActiveTooltip && b12ActiveWord) b12PositionTooltip(b12ActiveTooltip, b12ActiveWord);
}
function b12PlaySent(uid, sentence, si) {
  const item = lastAnalyzedData[si];
  const spName = item ? item.speaker||"__" : "__";
  toggleCardAudio(uid, sentence, si);
}
function b12TogglePlainBtn(btn, uid) {
  const card = btn.closest(".sent-card");
  const sentence = card ? card.getAttribute("data-sentence") : "";
  b12TogglePlain(uid, sentence);
}
function b12TogglePlain(uid, sentence) {
  const el = document.getElementById("b12sent_"+uid);
  if (!el) return;
  if (el.dataset.mode === "plain") {
    el.innerHTML = el.dataset.analysis;
    el.dataset.mode = "analysis";
  } else {
    el.dataset.analysis = el.innerHTML;
    el.innerHTML = `<span style="user-select:text;font-size:15px;line-height:1.8;white-space:pre-wrap">${sentence}</span>`;
    el.dataset.mode = "plain";
  }
}
// ── Shared chunk+word renderer (A1 & A2) ──────────────────────
function buildChunkCardHtml(sentence, data, uid, si, level) {
  const s = getStats();
  const saved = new Set((s.savedWordsList||[]).map(w=>w.key));
  const chunks = data.chunks||[];
  const isA1 = level === "A1-A2";
  const LV_BG  = {A1:"#dff0d8",A2:"#d9edf7",B1:"#fcf8e3",B2:"#f2dede",C1:"#e8daef",C2:"#e8daef"};
  const LV_COL = {A1:"#3c763d",A2:"#31708f",B1:"#8a6d3b",B2:"#a94442",C1:"#6c3483",C2:"#6c3483"};
  const typeMap = {
    "noun":"noun","verb":"verb","adjective":"adj","adverb":"adv",
    "pronoun":"pron","preposition":"prep","conjunction":"conj",
    "article":"art","auxiliary":"aux","phrasal verb":"phr.v","phrase":"phrase",
    "noun/adjective":"noun/adj","modal":"modal"
  };
  function chipHtml(lv) {
    if(!lv) return "";
    return `<span style="font-size:10px;font-weight:600;padding:1px 5px;border-radius:4px;background:${LV_BG[lv]||"#eee"};color:${LV_COL[lv]||"#555"};flex-shrink:0">${lv}</span>`;
  }
  // Helper: detect Vietnamese text by diacritics
  function isVietnamese(str) {
    return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(str||"");
  }
  // ── Chunk rows ────────────────────────────────────────────────
  const chunksHtml = chunks.map((c,ci)=>{
    // Auto-fix: if AI swapped text/meaning (Vietnamese in text field), swap back
    let chunkEn = c.text||"";
    let chunkVi = c.meaning||"";
    if(isVietnamese(chunkEn) && !isVietnamese(chunkVi) && chunkVi) {
      [chunkEn, chunkVi] = [chunkVi, chunkEn];
    }
    const chunkKey = `chunk_${chunkEn.replace(/\s+/g,"_").replace(/[^a-zA-Z0-9_]/g,"").slice(0,30)}`;
    const isSavedChunk = saved.has(chunkKey);
    // Auto grammar hint if AI returned null/empty
    function autoGrammar(chunkText, grammarRaw) {
      const g = (grammarRaw||"").toLowerCase().trim();
      if(g && g !== "null") return grammarRaw;
      const t = chunkText.toLowerCase();
      // Detect common patterns
      if(/\b(was|were|is|are|am|been|be)\b.*\b(v3|ed|en)\b/.test(t)||/\b(was|were)\s+\w+(ed|en|t)\b/.test(t)) return "passive (be + V3)";
      if(/\b(has|have|had)\s+been\b/.test(t)) return "present perfect cont.";
      if(/\b(has|have|had)\s+\w+(ed|en)\b/.test(t)) return "perfect (have + V3)";
      if(/\b(is|are|am|was|were)\s+\w+ing\b/.test(t)) return "continuous (be + V-ing)";
      if(/\b(will|won't|would|could|should|might|must|can)\b/.test(t)) return "modal verb";
      if(/\b(is|are|am|was|were)\s+going\s+to\b/.test(t)) return "be going to";
      if(/\b(was|were)\s+able\s+to\b/.test(t)||/\b(is|are)\s+able\s+to\b/.test(t)) return "be able to";
      if(/^(in|at|on|for|by|with|from|to|of|about|into|through|during|before|after)\b/.test(t)) return "prep. phrase";
      if(/\b(who|which|that|where|whose)\b/.test(t)) return "relative clause";
      if(/\b(because|although|while|when|if|since|unless)\b/.test(t)) return "subordinate clause";
      if(/\b(and|but|or|so)\b/.test(t)&&t.split(' ').length>2) return "coordinating";
      return "";
    }
    const grammarNote = autoGrammar(chunkEn, c.grammar);
    const rawTokens = c.tokens||[];
    const chunkLower = chunkEn.toLowerCase();
    const tokenPositions = new Map();
    let searchPos = 0;
    const sorted = [...rawTokens].sort((a,b)=>b.length-a.length);
    const usedRanges = [];
    sorted.forEach(tok => {
      let pos = 0;
      while(pos < chunkLower.length) {
        const idx = chunkLower.indexOf(tok.toLowerCase(), pos);
        if(idx === -1) break;
        const overlaps = usedRanges.some(([s,e])=>idx<e && idx+tok.length>s);
        if(!overlaps) {
          tokenPositions.set(tok, idx);
          usedRanges.push([idx, idx+tok.length]);
          break;
        }
        pos = idx+1;
      }
      if(!tokenPositions.has(tok)) tokenPositions.set(tok, 9999);
    });
    const sortedTokens = [...rawTokens].sort((a,b)=>
      (tokenPositions.get(a)??9999)-(tokenPositions.get(b)??9999)
    );
    function groupTokens(tokens) {
      const groups = [];
      let i = 0;
      // Trước tiên: tìm cặp phrasal verb từ PHRASAL_VERB_MAP
      // Đánh dấu các vị trí đã xử lý
      const phrasalPairs = [
        ["carried","out"],["carry","out"],["called","off"],["call","off"],
        ["set","up"],["broke","out"],["break","out"],["turned","down"],["turn","down"],
        ["gave","up"],["give","up"],["found","out"],["find","out"],["ruled","out"],
        ["took","over"],["take","over"],["put","forward"],["put","off"],
        ["pointed","out"],["cracked","down"],["led","to"],["came","up"],
        ["broken","out"],["given","up"],["taken","over"],["turned","out"],
      ];
      while(i < tokens.length) {
        const t = tokens[i].toLowerCase();
        const next = i+1 < tokens.length ? tokens[i+1].toLowerCase() : "";
        const next2 = i+2 < tokens.length ? tokens[i+2].toLowerCase() : "";
        // ƯUTIÊN 0: Phrasal verb pairs — ghép ngay
        const isPhrasal = phrasalPairs.some(([v,p]) => t===v && next===p);
        if (isPhrasal) {
          groups.push(tokens.slice(i, i+2)); i+=2; continue;
        }
        if(/^(has|have|had)$/.test(t) && next==="been" && next2) {
          groups.push(tokens.slice(i,i+3)); i+=3; continue;
        }
        if(/^(has|have|had)$/.test(t) && next && /\w+(ed|en|t)$/.test(next)) {
          groups.push(tokens.slice(i,i+2)); i+=2; continue;
        }
        if(/^(is|are|am|was|were|be)$/.test(t) && /^(being|\w+ing|\w+(ed|en|t))$/.test(next)) {
          groups.push(tokens.slice(i,i+2)); i+=2; continue;
        }
        if(/^(will|won't|would|could|should|might|must|can|cannot|can't|shall)$/.test(t) && next && !/^(the|a|an|i|you|he|she|it|we|they)$/.test(next)) {
          groups.push(tokens.slice(i,i+2)); i+=2; continue;
        }
        if(t==="to" && next && /^[a-z]+$/.test(next) && !/^(the|a|an|this|that|my|your|his|her|its|our|their)$/.test(next)) {
          groups.push(tokens.slice(i,i+2)); i+=2; continue;
        }
        if(next && /^(at|for|up|on|in|out|off|down|into|about|after|away|back|over|through|with|to)$/.test(next) && i+2<tokens.length) {
          groups.push(tokens.slice(i,i+2)); i+=2; continue;
        }
        if(/^(in|at|on|for|by|with|from|into|through|during|before|after|without|about|around)$/.test(t) && i+2<tokens.length) {
          if(/^(a|an|the|this|that|my|your|his|her|its|our|their)$/.test(next)) {
            groups.push(tokens.slice(i,i+3)); i+=3; continue;
          }
          if(next && !/^(a|an|the|in|at|on|for|by)$/.test(next)) {
            groups.push(tokens.slice(i,i+2)); i+=2; continue;
          }
        }
        if(/^(a|an|the)$/.test(t) && next && !/^(a|an|the)$/.test(next)) {
          groups.push(tokens.slice(i,i+2)); i+=2; continue;
        }
        groups.push([tokens[i]]); i++;
      }
      return groups;
    }
    function getLemma(tok) {
      const winfo = (data.words||{})[tok] || (data.words||{})[tok?.toLowerCase()] || {};
      const lemma = winfo.lemma;
      if(lemma && lemma !== tok && lemma !== "null" && lemma !== tok.toLowerCase()) return lemma;
      return null;
    }
    let bodyHtml = "";
    if(!isA1) {
      // chunkTM: token_meanings của chunk cha — đã có context đúng, ưu tiên số 1
      const chunkTM = c.token_meanings || {};
      const tokenGroups = groupTokens(sortedTokens);
      bodyHtml = tokenGroups.map(grp=>{
        const grpText = grp.join(" ");
        const grpLower = grpText.toLowerCase();
        let winfo = (data.words||{})[grpText] || (data.words||{})[grpLower] || {};
        if(!winfo.meaning) {
          const ft = grp[0];
          winfo = (data.words||{})[ft] || (data.words||{})[ft?.toLowerCase()] || {};
        }
        const typeLbl = grp.length===1 ? (winfo.type?(typeMap[winfo.type.toLowerCase()]||winfo.type):"") : "";
        const lvChipStr = grp.length===1 ? chipHtml(winfo.level) : "";
        const lemma = grp.length===1 ? getLemma(grp[0]) : null;

        // Lấy meaning theo thứ tự ưu tiên:
        // 1. chunk cha token_meanings (context đúng) — VD: chunk "On Saturday" có {On: "vào", Saturday: "thứ Bảy"}
        // 2. PROPER_NOUN_MAP (bảng cứng)
        // 3. Article fix (the/a/an không được dịch là "cái")
        // 4. data.words fallback (dễ sai vì không có context)
        function getCleanMeaning(tok, winfo_) {
          const tl = (tok||"").toLowerCase().trim();

          // 1. chunk cha token_meanings
          const ctmKey = Object.keys(chunkTM).find(k => k.toLowerCase().trim() === tl);
          if (ctmKey !== undefined) {
            const ctmVal = (chunkTM[ctmKey]||"").trim();
            if (ctmVal && ctmVal !== "null" && ctmVal !== "(particle)") return ctmVal;
          }

          // 2. proper noun map
          if (PROPER_NOUN_MAP[tl]) return PROPER_NOUN_MAP[tl];

          // 3. article fix
          if (/^(the|a|an)$/i.test(tl)) {
            const m2 = (winfo_?.meaning || "").trim();
            if (!m2 || /^(cái|một cái|các|những)(\s|$)/.test(m2)) return "(mạo từ)";
          }

          // 4. data.words fallback
          return (winfo_?.meaning || "").trim();
        }

        const combinedMeaning = grp.length>1
          ? grp.map(t=>{
              const wi = (data.words||{})[t]||(data.words||{})[t?.toLowerCase()]||{};
              return getCleanMeaning(t, wi);
            }).filter(Boolean).join(" · ")
          : getCleanMeaning(grp[0], winfo);
        const subGram = grp.length>1 ? autoGrammar(grpText,"") : "";
        // Lưu từ: key = grpText + lemma
        const rowKey = `${grpText}_${winfo.lemma||grp[0]}`;
        const rowSaved = saved.has(rowKey);
        const rowMeaningClean = combinedMeaning;
        const rowLevel = winfo.level || "";
        return `<div style="display:grid;grid-template-columns:20% 116px 44px 1fr auto 22px 22px 22px;align-items:center;gap:6px;padding:8px 8px;border-bottom:1px solid #f0f4f8">
<span style="font-weight:600;color:#0a2540;font-size:13px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${grpText}${lemma?`<span style="font-size:10px;color:#aed6f1;margin-left:5px;font-weight:400">←${lemma}</span>`:""}</span>
<span style="font-size:10px;color:#666;background:#f0f2f7;padding:2px 8px;border-radius:4px;white-space:nowrap;display:inline-block;max-width:110px;overflow:hidden;text-overflow:ellipsis">${typeLbl}</span>
<span>${lvChipStr}</span>
<span style="font-size:13px;color:#444;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${combinedMeaning}</span>
${subGram?`<span style="font-size:10px;color:#e67e22;font-style:italic;font-family:monospace;white-space:nowrap">${subGram}</span>`:"<span></span>"}
<button onclick="event.stopPropagation();speechSynthesis.cancel();const u=new SpeechSynthesisUtterance('${grpText.replace(/'/g,"\'")}');u.lang='en-US';u.rate=0.85;speechSynthesis.speak(u);" style="background:none;border:none;cursor:pointer;color:#5dade2;font-size:13px;padding:0;flex-shrink:0" title="Nghe từ">🔊</button>
<button onclick="event.stopPropagation();toggleSaveWord('${rowKey.replace(/'/g,"\'")}','${(winfo.lemma||grp[0]).replace(/'/g,"\'")}','${rowMeaningClean.replace(/'/g,"\'")}','${rowLevel}',this)" style="background:none;border:none;cursor:pointer;font-size:15px;padding:0;flex-shrink:0;color:${rowSaved?'#f5a623':'#ccc'}" title="Lưu từ">${rowSaved?"🌟":"☆"}</button>
<button onclick="event.stopPropagation();askWordAI('${uid}_row${ci}','${grpText.replace(/'/g,"\'")}',${JSON.stringify(sentence)})" style="background:none;border:none;cursor:pointer;font-size:14px;padding:0;flex-shrink:0;color:#aed6f1" title="Hỏi AI">💬</button>
</div>`;
      }).join("");
    }
    return `<div id="a2chunk_${uid}_${ci}" style="margin-bottom:6px;border:1px solid #e0eaf4;border-radius:8px;overflow:hidden">
<div style="display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f8fbff;cursor:pointer;user-select:none" onclick="toggleA2Chunk('${uid}_${ci}')">
<span id="a2arr_${uid}_${ci}" style="font-size:11px;color:#aaa;transition:transform .2s;flex-shrink:0">▶</span>
<span style="font-weight:600;font-size:13px;color:#0a2540;flex:1">${chunkEn}</span>
<span style="font-size:13px;color:#555;flex-shrink:0">${chunkVi}</span>
${grammarNote?`<span style="font-size:10px;color:#e67e22;font-style:italic;margin-left:6px;flex-shrink:0;font-family:monospace">${grammarNote}</span>`:""}
<button class="chunk-tts-btn" data-tts="${chunkEn.replace(/"/g,"&quot;")}" style="background:none;border:none;cursor:pointer;color:#5dade2;font-size:14px;padding:0 3px;flex-shrink:0">🔊</button>
<button class="chunk-ask-btn" data-text="${chunkEn.replace(/"/g,"&quot;")}" data-ctx="${sentence.replace(/"/g,"&quot;")}" style="background:none;border:none;cursor:pointer;color:#888;font-size:13px;padding:0 3px;flex-shrink:0" title="Hỏi AI">💬</button>
<button class="chunk-star ${isSavedChunk?"saved":""}" data-key="${chunkKey}" data-text="${chunkEn.replace(/"/g,"&quot;")}" data-meaning="${chunkVi.replace(/"/g,"&quot;")}" style="background:none;border:none;cursor:pointer;font-size:13px;color:#f5a623;padding:0 2px;flex-shrink:0">${isSavedChunk?"🌟":"☆"}</button>
</div>
${!isA1 ? `<div id="a2body_${uid}_${ci}" style="display:none;padding:4px 12px 8px">${bodyHtml}</div>` : ""}
</div>`;
  }).join("");
  let wordTableHtml = "";
  if(isA1) {
    const rawWords = Object.entries(data.words||{});
    const sentLower = sentence.toLowerCase();

    // ── Dedup: remove single-word entries whose text is fully covered by a phrase entry ──
    const phraseKeys = rawWords.filter(([w])=>w.includes(" ")).map(([w])=>w.toLowerCase());
    const allWords = rawWords.filter(([w])=>{
      if(!w.includes(" ")){
        // Remove if this single word appears inside any phrase key
        const wl=w.toLowerCase();
        return !phraseKeys.some(pk=>pk.split(/\s+/).includes(wl));
      }
      return true;
    });

    // Sort by position using tokenization — same logic as A1
    const sentToks2 = [];
    const re2 = /[\w']+|[^\w\s]/g; let m2;
    while((m2=re2.exec(sentence))!==null) sentToks2.push({word:m2[0],wordL:m2[0].toLowerCase(),start:m2.index,used:false});
    const posMap2 = new Map();
    const wordsSorted2 = [...allWords].sort((a,b)=>b[0].split(/\s+/).length-a[0].split(/\s+/).length||b[0].length-a[0].length);
    wordsSorted2.forEach(([w])=>{
      const wToks = w.trim().toLowerCase().split(/\s+/);
      for(let i=0;i<=sentToks2.length-wToks.length;i++){
        if(sentToks2[i].used) continue;
        let ok=true;
        for(let j=0;j<wToks.length;j++){const st=sentToks2[i+j];if(!st||st.used||st.wordL!==wToks[j]){ok=false;break;}}
        if(ok){posMap2.set(w,sentToks2[i].start);for(let j=0;j<wToks.length;j++)sentToks2[i+j].used=true;break;}
      }
      if(!posMap2.has(w)){const fi=sentLower.indexOf(w.toLowerCase());if(fi!==-1)posMap2.set(w,fi);}
    });
    allWords.sort(([a],[b])=>(posMap2.get(a)??9999)-(posMap2.get(b)??9999));
    function formulaHint(info) {
      const g = (info.grammar||"").toLowerCase();
      const lemma = info.lemma && info.lemma !== "null" ? info.lemma : "";
      const baseNote = lemma ? ` (← ${lemma})` : "";
      if(g.includes("past perfect")&&g.includes("cont")) return `had + been + V-ing${baseNote}`;
      if(g.includes("present perfect")&&g.includes("cont")) return `have/has + been + V-ing${baseNote}`;
      if(g.includes("past perfect")) return `had + V3${baseNote}`;
      if(g.includes("present perfect")) return `have/has + V3${baseNote}`;
      if(g.includes("past continuous")) return `was/were + V-ing${baseNote}`;
      if(g.includes("present continuous")||g.includes("be+v-ing")||g.includes("v-ing")) return `be + V-ing${baseNote}`;
      if(g.includes("passive")&&g.includes("past")) return `was/were + V3${baseNote}`;
      if(g.includes("passive")||g.includes("be+v3")) return `be + V3${baseNote}`;
      if(g.includes("v3")||g.includes("past part")||g.includes("particip")) return `V3 / past participle${baseNote}`;
      if(g.includes("future")||g.includes("will")) return `will + V${baseNote}`;
      if(g.includes("going to")) return `be going to + V${baseNote}`;
      if(g.includes("used to")) return `used to + V${baseNote}`;
      if(g.includes("modal")) return (info.grammar||"modal + V") + baseNote;
      if(g.includes("past simple")||g.includes("v2")) return `past simple (V2)${baseNote}`;
      if(info.irregular && info.irregular !== "null" && info.irregular !== "") return `irregular: ${info.irregular}`;
      if(lemma) return `base: ${lemma}`;
      return info.grammar||"";
    }
    // ── Smart tense label for phrases with base form ──────────
    function phraseTenseLabel(w, info) {
      const wl = w.toLowerCase();
      const lemma = info.lemma||(info.words&&Object.values(info.words||{})[0]?.lemma)||"";
      const base = lemma && lemma.toLowerCase()!==wl && lemma!=="null" ? ` ← ${lemma}` : "";
      // Expanded irregular V2 list for phrase detection
      const v2pat = /\b(went|came|got|took|made|said|told|saw|knew|gave|found|thought|left|kept|brought|bought|caught|felt|heard|held|lost|met|paid|put|ran|sent|set|showed|sat|slept|stood|taught|wore|won|wrote|began|broke|built|chose|drew|drank|drove|ate|fell|fed|fought|flew|forgot|froze|grew|hung|had|hit|hurt|kept|knelt|laid|led|let|lay|lit|meant|rode|rang|rose|sang|sank|shook|shone|shot|slid|spoke|sped|spent|spread|stole|stuck|stung|struck|swam|swung|tore|threw|understood|woke|withdrew|beat|bent|bet|bit|bled|blew|bred|crept|cut|dealt|dug|dove|forbade|forgave|hid|leant|leapt|learnt|lent|smelt|burnt|dreamt|spelt|dwelt|swept|wept)\b/;
      if(v2pat.test(wl)) return `V2${base}`;
      // Tense patterns from most specific to least
      if(/\bused to\b/.test(wl)) return `used to + V${base}`;
      if(/\bgoing to\b/.test(wl)) return `be going to + V${base}`;
      if(/\b(have|has|had)\s+been\b.*ing\b/.test(wl)) return `have + been + V-ing${base}`;
      if(/\b(have|has|had)\b.*\b(been|gone|come|done|made|taken|given|known|seen|told|written|spoken|broken|chosen|fallen|forgotten|grown|hidden|ridden|risen|run|shown|stolen|sworn|thrown|woken|worn|beaten|begun|blown|bought|built|caught|dealt|drawn|driven|eaten|fed|felt|fought|found|flown|frozen|got|gotten|heard|held|hurt|kept|laid|led|left|lent|lost|meant|met|paid|rung|said|sat|sent|set|shaken|shone|shot|shrunk|shut|sung|sunk|slept|slid|smelt|sped|spent|spread|stood|stuck|stung|struck|swum|swung|taught|torn|thought|understood|withdrawn)\b/.test(wl)) return `have + V3${base}`;
      if(/\b(was|were)\s+being\b.*\b\w+(ed|en)\b/.test(wl)) return `be + being + V3 (passive cont.)${base}`;
      if(/\b(is|are|am|was|were|been)\b.*\b(been|gone|done|made|taken|given|known|seen|told|written|spoken|broken|chosen|fallen|forgotten|grown|hidden|ridden|risen|run|shown|stolen|thrown|woken|worn|beaten|blown|bought|built|caught|drawn|driven|eaten|felt|fought|found|frozen|gotten|heard|held|hurt|kept|laid|led|lost|paid|rung|said|sat|sent|set|shaken|shot|sung|sunk|slept|spent|spread|stood|stuck|struck|swung|taught|torn|thought|thrown)\b/.test(wl)) return `be + V3 (passive)${base}`;
      if(/\b(was|were)\b.*\bing\b/.test(wl)) return `was/were + V-ing${base}`;
      if(/\b(is|are|am)\b.*\bing\b/.test(wl)) return `be + V-ing${base}`;
      if(/\b(was|were)\b.*\b\w+(ed|en)\b/.test(wl)) return `be + V3 (passive)${base}`;
      if(/\b(will|would|shall)\s+have\s+been\b/.test(wl)) return `will + have + been${base}`;
      if(/\b(will|would|shall)\s+have\b/.test(wl)) return `will + have + V3${base}`;
      if(/\b(will|would|shall)\s+be\b.*\bing\b/.test(wl)) return `will + be + V-ing${base}`;
      if(/\b(will|would|shall)\s+be\b/.test(wl)) return `will + be${base}`;
      if(/\b(can't|cannot|couldn't|won't|wouldn't|shouldn't|mustn't|don't|doesn't|didn't|haven't|hasn't|hadn't|isn't|aren't|wasn't|weren't)\b/.test(wl)) return `phủ định${base}`;
      if(/\b(can|could|may|might|must|shall|should|will|would)\b.*\bbe\b.*\bing\b/.test(wl)) return `modal + be + V-ing${base}`;
      if(/\b(can|could|may|might|must|shall|should|will|would)\b.*\bbe\b/.test(wl)) return `modal + be${base}`;
      if(/\b(can|could|may|might|must|shall|should|will|would)\b/.test(wl)) return `modal + V${base}`;
      if(/\b(but|and|or|so|yet|although|because|when|while|after|before|since|until|if|unless|though)\b/.test(wl)) return `connector${base}`;
      return null;
    }
    const rows = allWords.map(([w,info],wi)=>{
      const key = `${w}_${info.lemma||w}`;
      const isSaved = saved.has(key);
      const isPhrase = w.trim().includes(" ");
      // Smart label for phrases
      let typeLbl = "";
      if(isPhrase){
        const wl=w.toLowerCase();
        const g=(info.grammar||"").toLowerCase();
        // Verb tense groups
        if(/\b(used to|going to|have been|has been|had been|will be|would be|is being|are being|was being|be able to|went|came|got|took|made|said|told|saw|knew|gave|found|thought|left|kept|bought|felt|heard|held|lost|met|paid|ran|sent|sat|slept|stood|taught|wore|won|wrote)\b/.test(wl)||
           /\b(don't|doesn't|didn't|won't|can't|couldn't|wouldn't|shouldn't|haven't|hasn't|hadn't)\b/.test(wl)||
           /\b(am|is|are|was|were|has|have|had|will|would|can|could|shall|should|may|might|must)\b/.test(wl)||
           g.includes("tense")||g.includes("perfect")||g.includes("continuous")||g.includes("passive")||g.includes("used to")||g.includes("going to")||g.includes("past simple")||g.includes("V2")){
          // Use phraseTenseLabel for accurate formula with base form
          typeLbl=phraseTenseLabel(w,info)||g||"verb group";
        }
        // Connector + clause
        else if(/^(but |and |or |so |yet |although |because |when |while |after |before |since |until |if |unless |though )/.test(wl)){
          typeLbl="connector + V-ing";
        }
        // Fixed expressions
        else if(/^(a lot of|lots of|there (is|are|was|were)|as well as|in spite of|in order to|such as|as soon as|at least|in fact|of course|by the way|on the other hand|for example|in addition|as a result|due to|because of|instead of|according to|in front of|next to|far from|close to|thanks to|in case of|as long as|so that|even though|even if|no matter|as if|as though)\b/.test(wl)){
          typeLbl="fixed expression";
        }
        // Prepositional phrases
        else if(/^(in|on|at|to|from|with|by|for|of|about|into|onto|under|over|above|below|between|among|through|across|along|around|behind|beside|near|off|out of|up|down|upon|within|without|except|despite|during|before|after|since|until|till|against|beyond|past|per)\b/.test(wl)){
          const prep=wl.split(" ")[0];
          typeLbl=`${prep} + noun`;
        }
        // Noun phrases (article/det + noun)
        else if(/^(a |an |the |this |that |these |those |my |your |his |her |its |our |their |some |any |each |every |both |all |no )/.test(wl)){
          const hasAdj=/\b(big|small|old|new|good|bad|long|short|high|low|fast|slow|beautiful|important|different|large|great|little|young|early|late|hard|free|real|best|right|left|wrong|same|last|next|own|local|public|private|national|international)\b/.test(wl);
          typeLbl=hasAdj?"det + adj + noun":"det + noun";
        }
        // Proper nouns (all caps words)
        else if(/\b[A-Z][a-z]+(\s+[A-Z][a-z]+)+/.test(w)){
          typeLbl="proper noun";
        }
        else typeLbl=info.grammar||info.type||"phrase";
      } else {
        const baseType = info.type ? (typeMap[info.type.toLowerCase()]||info.type) : "";
        // For single verbs, compute form tag and show it in the type chip
        const singleFormTag = (() => {
          if (!baseType || !["verb","aux","phrasal verb"].includes(baseType)) return "";
          const tl2 = w.toLowerCase();
          const ll2 = (info.lemma||"").toLowerCase();
          const gl2 = (info.grammar||"").toLowerCase();
          if (gl2.includes("v3")||gl2.includes("past part")||gl2.includes("passive")||gl2.includes("particip")) return "V3";
          if (gl2.includes("v-ing")||gl2.includes("gerund")||tl2.endsWith("ing")) return "V-ing";
          if (gl2.includes("v2")||gl2.includes("past simple")||gl2.includes("simple past")||(gl2.includes("past")&&!gl2.includes("particip"))) return "V2";
          if (tl2 && ll2 && tl2 !== ll2) {
            if (tl2.endsWith("ing")) return "V-ing";
            if (IRREG_V3.has(tl2)) return "V3";
            if (IRREG_V2.has(tl2)) return "V2";
            if (tl2.endsWith("ed")) return (gl2.includes("particip")||gl2.includes("passive")) ? "V3" : "V2";
          }
          return "";
        })();
        typeLbl = singleFormTag ? `${baseType} · ${singleFormTag}` : baseType;
      }
      const levelLbl = isPhrase ? "" : info.level;
      // Show lemma for both single words AND verb-type phrases (e.g. "went" in phrase: → go)
      const phraseLemma = isPhrase && info.lemma && info.lemma !== w && info.lemma !== "null" &&
        (typeLbl.startsWith("V")||typeLbl.includes("past")||typeLbl.includes("perf")||typeLbl.includes("modal")||typeLbl.includes("passive")||typeLbl.includes("cont.")||typeLbl.includes("used to")||typeLbl.includes("going to")) ? info.lemma : "";
      const lemma = !isPhrase && info.lemma && info.lemma !== w && info.lemma !== "null" ? info.lemma : phraseLemma;
      const formula = isPhrase ? "" : formulaHint(info);
      const example = info.example && info.example !== "null" && info.example !== "example" && info.example.trim() ? info.example.trim() : "";
      const wid = `${uid}_${wi}`;
      return `<li class="word-item" id="wi_${wid}">
<div class="word-item-header" onclick="toggleWordItem('${wid}','${esc(key)}','${esc(info.lemma||w)}','${esc(info.meaning||"")}','${info.level||""}')">
<span class="word-chevron">▶</span>
<button class="word-star ${isSaved?"saved":""}" onclick="event.stopPropagation();toggleSaveWord('${esc(key)}','${esc(info.lemma||w)}','${esc(info.meaning||"")}','${info.level||""}',this)">${isSaved?"🌟":"☆"}</button>
<span style="font-weight:700;color:#0a2540;font-size:14px;word-break:break-word;line-height:1.3">${w}${lemma?`<span style="font-size:10px;color:#aed6f1;margin-left:5px;font-weight:400">←${lemma}</span>`:""}</span>
<span style="font-size:10px;color:${isPhrase?"#1a5f8a":"#666"};background:${isPhrase?"#e8f4fd":"#f0f2f7"};padding:2px 8px;border-radius:4px;white-space:nowrap;flex-shrink:0;display:inline-block;max-width:110px;overflow:hidden;text-overflow:ellipsis">${typeLbl}</span>
<span style="text-align:center">${levelLbl?chipHtml(levelLbl):""}</span>
<span style="font-size:13px;color:#444;word-break:break-word;line-height:1.3">${(info.meaning&&info.meaning!=="null"&&info.meaning!=="meaning"&&info.meaning!=="lemma"&&info.meaning!=="level"&&info.meaning!=="type"&&info.meaning!=="grammar"&&info.meaning!=="example"&&info.meaning.trim())?info.meaning.trim():""}</span>
<button class="word-ask-btn-inline" onclick="event.stopPropagation();sentTTS('${esc(w)}')" title="Nghe">🔊</button>
<button class="word-ask-btn-inline" onclick="event.stopPropagation();askWordAI('${wid}','${esc(w)}',${JSON.stringify(sentence)})" title="Hỏi AI">💬</button>
</div>
<div class="word-item-body">
${formula?`<div class="word-meta" style="color:#e67e22;font-size:11px;font-family:monospace">${formula}</div>`:""}
${example?`<div class="word-example" style="margin-top:4px">📌 ${example}</div>`:""}
<div id="wai_${wid}" style="display:none" class="word-ai-box"></div>
</div>
</li>`;
    }).join("");
    wordTableHtml = rows ? `<div class="vocab-label" style="margin-top:6px">Từ vựng</div>
<ul class="word-list">${rows}</ul>` : "";
  }
  return `<div id="sa_${uid}" data-sentence="${sentence.replace(/"/g,"&quot;")}">
<div class="translation"><span class="translation-text">${data.sentence||"—"}</span></div>
<div id="aiSent_${uid}" style="display:none" class="ai-explain-box"></div>
${chunks.length?`<div class="vocab-label" style="margin-top:8px;margin-bottom:6px">Cụm từ</div>${chunksHtml}`:""}
${wordTableHtml}
</div>`;
}
function sentTTS(text){speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(text);u.lang="en-US";u.rate=0.85;try{applyVolume(u);}catch(e){}speechSynthesis.speak(u);}
function attachChunkEvents(uid) {
  document.querySelectorAll(`#sa_${uid} .chunk-tts-btn`).forEach(btn=>{
    btn.onclick = e => { e.stopPropagation(); speechSynthesis.cancel(); const u=new SpeechSynthesisUtterance(btn.dataset.tts); u.lang="en-US"; applyVolume(u); speechSynthesis.speak(u); };
  });
  document.querySelectorAll(`#sa_${uid} .chunk-star`).forEach(btn=>{
    btn.onclick = e => { e.stopPropagation(); toggleSaveWord(btn.dataset.key, btn.dataset.text, btn.dataset.meaning, "", btn); };
  });
  document.querySelectorAll(`#sa_${uid} .chunk-ask-btn`).forEach(btn=>{
    btn.onclick = e => {
      e.stopPropagation();
      const phrase = btn.dataset.text;
      const ctx = btn.dataset.ctx;
      const chunk = btn.closest('[id^="a2chunk_"]');
      if(!chunk) return;
      let aiBox = chunk.nextElementSibling?.classList.contains("chunk-ai-box") ? chunk.nextElementSibling : null;
      if(!aiBox) {
        aiBox = document.createElement("div");
        aiBox.className = "chunk-ai-box";
        aiBox.style.cssText = "padding:8px 12px;background:#f0f8ff;border-radius:0 0 8px 8px;font-size:13px;color:#333;border:1px solid #e0eaf4;border-top:none;margin-bottom:6px;margin-top:-6px";
        chunk.after(aiBox);
      }
      if(aiBox.dataset.open==="1"){aiBox.remove();return;}
      aiBox.dataset.open="1";
      aiBox.innerHTML="⏳ ...";
      callWorker("phrase_explain", { phrase, context: ctx }).then(text=>{
        aiBox.innerHTML = `<div style="font-size:12px;line-height:1.8;color:#333">${(text||"—").replace(/\n/g,"<br>")}</div>`;
      }).catch(()=>{ aiBox.innerHTML="❌ Lỗi kết nối"; });
    };
  });
}
function buildA2Html(sentence, data, uid, si) {
  const html = buildChunkCardHtml(sentence, data, uid, si, "B1");
  setTimeout(()=>attachChunkEvents(uid), 0);
  return html;
}
function buildA1Html(sentence, data, uid, si) {
  const s = getStats();
  const saved = new Set((s.savedWordsList||[]).map(w=>w.key));
  const uid2 = uid || ("a1_"+si);
  const LV_BG  = {A1:"#dff0d8",A2:"#d9edf7",B1:"#fcf8e3",B2:"#f2dede",C1:"#e8daef",C2:"#e8daef"};
  const LV_COL = {A1:"#3c763d",A2:"#31708f",B1:"#8a6d3b",B2:"#a94442",C1:"#6c3483",C2:"#6c3483"};
  const typeMap = {
    "noun":"noun","verb":"verb","adjective":"adj","adverb":"adv",
    "pronoun":"pron","preposition":"prep","conjunction":"conj",
    "article":"art","auxiliary":"aux","phrasal verb":"phr.v","phrase":"phrase","modal":"modal"
  };
  function chipHtml(lv) {
    if(!lv) return "";
    return `<span style="font-size:10px;font-weight:600;padding:1px 5px;border-radius:4px;background:${LV_BG[lv]||"#eee"};color:${LV_COL[lv]||"#555"};flex-shrink:0">${lv}</span>`;
  }
  function esc(s){ return (s||"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

  function formulaHintA1(info) {
    const g = (info.grammar||"").toLowerCase();
    const lemma = info.lemma && info.lemma!=="null" ? info.lemma : "";
    const baseNote = lemma ? ` (← ${lemma})` : "";
    if(g.includes("past perfect")&&g.includes("cont")) return `had + been + V-ing${baseNote}`;
    if(g.includes("past perfect")) return `had + V3${baseNote}`;
    if(g.includes("present perfect")) return `have/has + V3${baseNote}`;
    if(g.includes("past continuous")) return `was/were + V-ing${baseNote}`;
    if(g.includes("present continuous")||g.includes("v-ing")||g.includes("gerund")) return `be + V-ing${baseNote}`;
    if(g.includes("passive")) return `be + V3${baseNote}`;
    if(g.includes("v3")||g.includes("past part")) return `V3 (past participle)${baseNote}`;
    if(g.includes("modal")) return (info.grammar||"modal + V")+baseNote;
    if(g.includes("v2")||g.includes("past simple")) return `past simple (V2)${baseNote}`;
    if(info.irregular && info.irregular!=="null" && info.irregular!=="") return `irregular: ${info.irregular}`;
    if(lemma) return `base: ${lemma}`;
    return info.grammar||"";
  }

  const sentLower = sentence.toLowerCase();
  // Tokenize sentence into actual word tokens with positions
  // Each token: {word, start, end, used}
  const sentTokens = [];
  const tokRe = /[\w']+|[^\w\s]/g;
  let m;
  while((m = tokRe.exec(sentence)) !== null) {
    sentTokens.push({word: m[0], wordL: m[0].toLowerCase(), start: m.index, end: m.index+m[0].length, used: false});
  }
  // Match each AI word to a sentence token (greedy: longer keys first, each token used once)
  const aiEntries = Object.entries(data.words||{}).filter(([w,info])=>{
    // Pre-filter: skip empty keys, pure-punctuation keys, bad meanings
    if(!w || !w.trim()) return false;
    if(/^[\s.,!?;:'"()\[\]{}-]+$/.test(w.trim())) return false; // pure punctuation
    const m = (info.meaning||"").trim();
    // Only skip clearly bad meanings: empty, "null", exact same as key (AI echoed the word)
    if(!m || m==="null" || m==="—") return false;
    // Skip if meaning IS the English word itself (case-insensitive) — AI didn't translate
    const mLower = m.toLowerCase(), wLower2 = w.trim().toLowerCase();
    if(mLower === wLower2) return false; // e.g. meaning:"do" for key "do"
    // Don't skip "Hi"→"Xin chào" or any legitimate Vietnamese meaning
    return true;
  });
  const posMap = new Map(); // key -> token start position
  // Sort by token length desc so multi-word phrases match before single words
  const aiSorted = [...aiEntries].sort((a,b)=>b[0].split(/\s+/).length-a[0].split(/\s+/).length || b[0].length-a[0].length);
  aiSorted.forEach(([w])=>{
    const wTrim = w.trim();
    if(!wTrim) return;
    const wTokens = wTrim.toLowerCase().split(/\s+/);
    // Try to find consecutive matching tokens (exact match)
    for(let i=0; i<=sentTokens.length-wTokens.length; i++){
      if(sentTokens[i].used) continue;
      let match = true;
      for(let j=0; j<wTokens.length; j++){
        const st = sentTokens[i+j];
        if(!st || st.used || st.wordL !== wTokens[j]){ match=false; break; }
      }
      if(match){
        posMap.set(w, sentTokens[i].start);
        for(let j=0; j<wTokens.length; j++) sentTokens[i+j].used = true;
        break;
      }
    }
    // Contraction fallback: AI sent "It" but token is "It's" → match stem
    if(!posMap.has(w) && wTrim.length > 1){
      const wl = wTrim.toLowerCase();
      // Try: find a token that STARTS WITH this key (contraction stem match)
      // e.g. key="It" matches token="it's", key="I" matches token="i'm"
      const stemMatch = sentTokens.find(t=>!t.used && t.wordL.startsWith(wl) && t.wordL.length > wl.length && t.wordL[wl.length]==="'");
      if(stemMatch){ posMap.set(w, stemMatch.start); stemMatch.used=true; return; }
      // Last fallback: whole-word boundary check in original sentence
      // Simple fallback: only match if the found position is a real token boundary
      const fi2 = sentLower.indexOf(wl);
      if(fi2 !== -1) {
        // Check it's not a partial match (not inside a longer word/contraction)
        const before = fi2 > 0 ? sentLower[fi2-1] : ' ';
        const after = fi2+wl.length < sentLower.length ? sentLower[fi2+wl.length] : ' ';
        const isWordBoundary = !/[a-z']/i.test(before) && !/[a-z']/i.test(after);
        if(isWordBoundary) posMap.set(w, fi2);
      }
    }
  });
  // Filter: only keep words that got a real position match
  let allWords = aiEntries.filter(([w])=>posMap.has(w));
  // Sort by position
  allWords.sort(([a],[b])=>(posMap.get(a)??9999)-(posMap.get(b)??9999));
  
  // FALLBACK: if AI returned no usable words, build minimal entries from sentence tokens
  if(allWords.length === 0 && sentTokens.length > 0) {
    const wordData = data.words || {};
    const sentWords = sentTokens.filter(t=>!/^[.,!?;:'"()\[\]{}-]$/.test(t.word));
    allWords = sentWords.map((tok,i)=>{
      // Try to find any AI data for this token (case-insensitive search)
      const aiMatch = Object.entries(wordData).find(([k])=>k.toLowerCase()===tok.wordL || k===tok.word);
      if(aiMatch) return aiMatch;
      // No AI data — create minimal entry
      return [tok.word, {meaning:"—", level:"A1", type:"", grammar:null, example:""}];
    }).filter(([,info])=>{
      const m=(info.meaning||"").trim();
      return m && m!=="—" && m!=="null";
    });
  }

  // Client-side auxiliary meaning correction table
  const AUX_MEANING_FIX = {
    "do":"(trợ từ hỏi)","does":"(trợ từ hỏi)","did":"(trợ từ hỏi)",
    "do not":"không","does not":"không","did not":"không",
    "don't":"không","doesn't":"không","didn't":"không",
    "will":"sẽ","won't":"sẽ không","would":"sẽ/muốn","wouldn't":"không muốn",
    "shall":"sẽ","should":"nên","shouldn't":"không nên",
    "can":"có thể","can't":"không thể","cannot":"không thể",
    "could":"có thể","couldn't":"không thể",
    "may":"có thể","might":"có thể",
    "must":"phải","mustn't":"không được",
    "have to":"phải","has to":"phải","had to":"đã phải",
    "am":"là/đang","is":"là/đang","are":"là/đang",
    "was":"đã là","were":"đã là",
    "have":"có/đã","has":"có/đã","had":"đã có",
    "been":"(đã)","being":"(đang)",
  };
  const rows = allWords.map(([w,info],wi)=>{
    // Final guard: skip empty key or bad meaning that slipped through
    if(!w||!w.trim()) return "";
    const meaning2check = (info.meaning||"").trim();
    if(!meaning2check || meaning2check==="null") return ""; // only skip clearly empty
    // Apply aux correction if AI got it wrong
    const wLower = w.trim().toLowerCase();
    const auxFix = AUX_MEANING_FIX[wLower];
    if(auxFix && info.type && ["auxiliary","aux","verb"].includes((info.type||"").toLowerCase())) {
      // Only fix if meaning looks wrong (not Vietnamese-like)
      const m = (info.meaning||"").trim();
      const isVietnamese = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(m);
      if(!isVietnamese || m==="thì" || m==="thì." || m==="là thì" || m.length < 2) {
        info = {...info, meaning: auxFix};
      }
    }
    const key = `${w}_${info.lemma||w}`;
    const isSaved = saved.has(key);
    const baseType = info.type ? (typeMap[info.type.toLowerCase()]||info.type) : "";
    // Show form tag for verbs
    const tl = w.toLowerCase();
    const ll = (info.lemma||"").toLowerCase();
    const gl = (info.grammar||"").toLowerCase();
    let formTag = "";
    if(["verb","aux","phrasal verb","modal"].includes(baseType||"")) {
      if(gl.includes("v3")||gl.includes("past part")||gl.includes("passive")||gl.includes("particip")) formTag="V3";
      else if(gl.includes("v-ing")||gl.includes("gerund")||(tl.endsWith("ing")&&tl!==ll)) formTag="V-ing";
      else if(gl.includes("v2")||gl.includes("past simple")||(gl.includes("past")&&!gl.includes("particip"))) formTag="V2";
      else if(tl&&ll&&tl!==ll) {
        if(tl.endsWith("ing")) formTag="V-ing";
        else if(IRREG_V3.has(tl)) formTag="V3";
        else if(IRREG_V2.has(tl)) formTag="V2";
        else if(tl.endsWith("ed")) formTag="V2";
      }
    }
    const typeLbl = formTag ? `${baseType} · ${formTag}` : baseType;
    const lemmaDisplay = (info.lemma && info.lemma!==w && info.lemma!=="null") ? info.lemma : "";
    const formula = formulaHintA1(info);
    const example = info.example && info.example!=="null" ? info.example : "";
    // Guard: skip entries where meaning is clearly a field name/null
    const rawM = (info.meaning||"").trim();
    const rawMLower = rawM.toLowerCase();
    const wKey = w.trim().toLowerCase();
    // Skip row only if meaning is clearly wrong: empty, "null", "—", exact echo of the key, or a JSON field name
    const badM = !rawM || rawM==="null" || rawM==="—"
      || rawMLower === wKey  // AI echoed the word as meaning
      || ["meaning","lemma","level","type","grammar","example","word","phrase","null","undefined"].includes(rawMLower);
    if(badM) return ""; // skip row
    const meaning = rawM;
    const wid = `${uid2}_${wi}`;
    return `<li class="word-item" id="wi_${wid}">
<div style="display:flex;align-items:flex-start;gap:6px;padding:9px 8px;width:100%;cursor:pointer;box-sizing:border-box" onclick="toggleWordItem('${wid}','${esc(key)}','${esc(info.lemma||w)}','${esc(meaning)}','${info.level||""}')">
  <span class="word-chevron" style="flex-shrink:0;margin-top:2px">▶</span>
  <button class="word-star ${isSaved?"saved":""}" style="flex-shrink:0;background:none;border:none;cursor:pointer;font-size:16px;padding:0;margin:0;color:#ddd;line-height:1" onclick="event.stopPropagation();toggleSaveWord('${esc(key)}','${esc(info.lemma||w)}','${esc(meaning)}','${info.level||""}',this)">${isSaved?"🌟":"☆"}</button>
  <span style="flex:0 0 auto;width:28%;min-width:90px;max-width:200px;font-weight:700;color:#0a2540;font-size:14px;word-break:break-word;line-height:1.4">${w}${lemmaDisplay?`<span style="font-size:10px;color:#aed6f1;margin-left:5px">←${lemmaDisplay}</span>`:""}</span>
  <span style="flex:0 0 auto;width:120px;display:flex;gap:3px;align-items:center;flex-wrap:wrap">
    ${typeLbl?`<span style="font-size:10px;color:${(baseType==="verb"||baseType==="aux")?"#1a5f8a":"#666"};background:${(baseType==="verb"||baseType==="aux")?"#e8f4fd":"#f0f2f7"};padding:2px 6px;border-radius:4px;white-space:nowrap">${typeLbl}</span>`:""}
    ${chipHtml(info.level)}
  </span>
  <span style="flex:1;min-width:0;font-size:13px;color:#333;line-height:1.5;word-break:break-word">${meaning}</span>
  <button class="word-ask-btn-inline" style="flex-shrink:0" onclick="event.stopPropagation();sentTTS('${esc(w)}')" title="Nghe">🔊</button>
  <button class="word-ask-btn-inline" style="flex-shrink:0" onclick="event.stopPropagation();askWordAI('${wid}','${esc(w)}',${JSON.stringify(sentence)})" title="Hỏi AI">💬</button>
</div>
<div class="word-item-body">
${formula?`<div class="word-meta" style="color:#e67e22;font-size:11px;font-family:monospace">${formula}</div>`:""}
${example?`<div class="word-example" style="margin-top:4px">📌 ${example}</div>`:""}
<div id="wai_${wid}" style="display:none" class="word-ai-box"></div>
</div>
</li>`;
  }).filter(Boolean).join("");

  // Translation: use AI sentence first, fallback to word meanings
  let translation = (data.sentence||"").trim();
  if(!translation || translation==="null" || translation==="—" || translation===sentence) {
    // Try building from word meanings
    const builtTrans = Object.values(data.words||{})
      .map(info=>(info.meaning||"").trim())
      .filter(m=>m && m!=="null" && m!=="—" && !/^[a-zA-Z]+$/.test(m)) // keep only Vietnamese
      .join(" ");
    if(builtTrans) translation = builtTrans;
    else translation = sentence; // last resort: show original
  }
  return `<div id="sa_${uid2}" data-sentence="${sentence.replace(/"/g,"&quot;")}">
<div class="translation"><span class="translation-text">${translation}</span></div>
<div id="aiSent_${uid2}" style="display:none" class="ai-explain-box"></div>
${rows ? `<div class="vocab-label" style="margin-top:6px">Từ vựng</div><ul class="word-list">${rows}</ul>` : ""}
</div>`;
}

function buildA12Html(sentence, data, uid, si) {
  const html = buildChunkCardHtml(sentence, data, uid, si, "A1-A2");
  setTimeout(()=>attachChunkEvents(uid), 0);
  return html;
}
function toggleA2Chunk(id) {
  const body=document.getElementById("a2body_"+id);
  const arr=document.getElementById("a2arr_"+id);
  if(!body)return;
  const open=body.style.display!=="none";
  body.style.display=open?"none":"block";
  if(arr)arr.style.transform=open?"":"rotate(90deg)";
}
function openTest(){document.getElementById("testOverlay").classList.add("open");buildCurrentTest();}
function closeTest(){document.getElementById("testOverlay").classList.remove("open");}
let _examType="ielts";
let _examKind="de"; // 'de' (theo 1 folder cụ thể) | 'bai_kiem_tra' (hiện tại/từ đã lưu/từ đã tra/câu đã lưu)
let _examFolderId=null;
function setExamType(t){
  _examType=t;
  document.querySelectorAll("[data-exam]").forEach(b=>b.classList.toggle("active",b.dataset.exam===t));
  updateExamCreditInfo();
}
function setExamKind(kind){
  _examKind=kind;
  document.querySelectorAll("[data-kind]").forEach(b=>b.classList.toggle("active",b.dataset.kind===kind));
  const typeRow=document.getElementById("examTypeRow");
  const folderRow=document.getElementById("examSourceFolderRow");
  const srcRow=document.getElementById("examSourceButtonsRow");
  if(typeRow)typeRow.style.display=kind==="de"?"flex":"none";
  if(folderRow)folderRow.style.display=kind==="de"?"flex":"none";
  if(srcRow)srcRow.style.display=kind==="bai_kiem_tra"?"flex":"none";
  if(kind==="de")populateExamFolderSelect();
  updateExamCreditInfo();
}
function populateExamFolderSelect(){
  const sel=document.getElementById("examFolderSelect");
  if(!sel)return;
  const folders=mentorFolders.filter(f=>f.folder_type==="content");
  if(!folders.length){sel.innerHTML='<option value="">(chưa có folder nào)</option>';_examFolderId=null;return;}
  sel.innerHTML=folders.map(f=>`<option value="${f.id}">${f.name} (${f.level})</option>`).join("");
  _examFolderId=folders[0].id;
  sel.value=_examFolderId;
}
function onExamFolderChange(){
  const sel=document.getElementById("examFolderSelect");
  _examFolderId=sel?.value||null;
  updateExamCreditInfo();
}
function setTestSource(src){
  document.querySelectorAll("[data-src]").forEach(b=>b.classList.toggle("active",b.dataset.src===src));
  updateExamCreditInfo();
}
function updateExamCreditInfo(){
  const el=document.getElementById("examCreditInfo");
  if(!el)return;
  const creditCost=10;
  const s=getStats();
  const avail=(s.credits||0);
  const canAfford=avail>=creditCost;
  const btn=document.getElementById("btnCreateExam");

  if(_examKind==="de"){
    const folder=mentorFolders.find(f=>f.id===_examFolderId);
    const domLevel=folder?folder.level:"B1";
    const N=domLevel==="A1-A2"?10:30;
    const MIN_SAVED_CONTENT=10;
    const savedCount=_examFolderId?countHistoryInFolder(_examFolderId):0;
    const hasEnoughContent=savedCount>=MIN_SAVED_CONTENT;
    el.innerHTML=`💡 Đề <b>${_examType==="ptth"?"PTTH":"IELTS"}</b> · Level <b>${domLevel}</b> · <b>${N} câu</b> (4 kỹ năng)<br>
      💳 Chi phí: <b>${creditCost} credit</b> · Số dư: <b style="color:${canAfford?"#1e7e34":"#c0392b"}">${avail} credit</b><br>
      📚 Nội dung trong folder: <b style="color:${hasEnoughContent?"#1e7e34":"#c0392b"}">${savedCount}/${MIN_SAVED_CONTENT}</b>
      ${!canAfford?'<br>🔴 <span style="color:#c0392b;font-weight:700">Hết credit. Vui lòng nạp thêm credit.</span>':""}
      ${!hasEnoughContent?'<br>🔒 <span style="color:#c0392b;font-weight:700">Chưa đủ nội dung trong folder này.</span>':""}`;
    if(btn)btn.disabled=!canAfford||!hasEnoughContent||!_examFolderId;
  } else {
    const src=document.querySelector("[data-src].active")?.dataset.src||"current";
    const pool=collectPool(src);
    const domLevel=getDomLevel(pool)||"B1";
    const N=domLevel==="A1-A2"?10:30;
    el.innerHTML=`💡 Bài kiểm tra từ vựng · Level <b>${domLevel}</b> · <b>${N} câu</b><br>
      💳 Chi phí: <b>${creditCost} credit</b> · Số dư: <b style="color:${canAfford?"#1e7e34":"#c0392b"}">${avail} credit</b>
      ${!canAfford?'<br>🔴 <span style="color:#c0392b;font-weight:700">Hết credit. Vui lòng nạp thêm credit.</span>':""}`;
    if(btn)btn.disabled=!canAfford;
  }
  loadSavedExamsList();
}
function getDomLevel(pool){
  const lv={};pool.forEach(w=>{if(w.level)lv[w.level]=(lv[w.level]||0)+1;});
  return Object.entries(lv).sort((a,b)=>b[1]-a[1])[0]?.[0]||"B1";
}
function normalizeLibLevel(lv){
  return (lv==="A1"||lv==="A1-A2"||lv==="A2") ? "A1-A2"
    : lv==="B1" ? "B1"
    : lv==="B2" ? "B2"
    : "A1-A2";
}
function countHistoryInFolder(folderId){
  const h=JSON.parse(localStorage.getItem("history_en8")||"[]");
  return h.filter(x=>x.folderId===folderId).length;
}
function loadSavedExamsList(){
  const el=document.getElementById("savedExamsList");
  if(!el)return;
  if(!mentorExams.length){el.innerHTML='<div style="color:#aaa;font-size:12px;padding:4px 0">Chưa có đề nào. Nhấn "Tạo đề mới" để bắt đầu.</div>';return;}
  const LV_COL={"A1-A2":"#3c763d","B1":"#31708f","B2":"#8a6d3b"};
  el.innerHTML=mentorExams.map(e=>`
    <div style="display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid #eff2f7;cursor:pointer" onclick="openExam('${e.id}')">
      <div style="flex:1;min-width:0">
        <div style="font-size:12px;font-weight:600;color:#1a3c6e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${e.title}</div>
        <div style="font-size:10px;color:#888;margin-top:2px">${new Date(e.created_at).toLocaleDateString("vi-VN")} · ${e.questions_count} câu${e.last_score!=null?" · Điểm: "+e.last_score+"%":""}</div>
      </div>
      <span style="padding:2px 7px;border-radius:3px;font-size:10px;font-weight:700;color:#fff;background:${LV_COL[e.level]||"#555"};flex-shrink:0">${e.level}</span>
      <button onclick="event.stopPropagation();openExamStats('${e.id}')" style="background:none;border:none;cursor:pointer;color:#aaa;font-size:14px;padding:0 4px;flex-shrink:0" title="Thống kê">📊</button>
      <button onclick="event.stopPropagation();openShareModal('exam','${e.id}')" style="background:none;border:none;cursor:pointer;color:#aaa;font-size:14px;padding:0 4px;flex-shrink:0" title="Chia sẻ">🔗</button>
      <button onclick="event.stopPropagation();deleteExam('${e.id}')" style="background:none;border:none;cursor:pointer;color:#aaa;font-size:14px;padding:0 4px;flex-shrink:0" title="Xóa">🗑</button>
    </div>`).join("");
}
function openExam(examId){
  closeTest();
  examOpen(examId);
}
async function deleteExam(examId){
  if(!confirm("Xóa đề này?"))return;
  const { error } = await supabase.from("mentor_exams").delete().eq("id", examId);
  if (error) { alert("Lỗi xoá đề: "+error.message); return; }
  mentorExams = mentorExams.filter(e=>e.id!==examId);
  loadSavedExamsList();
}
function collectPool(src){
  function isViet(s){return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s||"");}
  let pool=[];
  if(src==="current"){
    lastAnalyzedData.forEach(d=>{
      const sent=d?.sentence||"";
      Object.entries(d?.data?.words||{}).forEach(([w,info])=>{
        if(info.meaning&&w.length>1&&!isViet(w))
          pool.push({word:info.lemma||w,display:w,meaning:info.meaning,level:info.level||"",grammar:info.grammar||"",sentence:sent,example:info.example||""});
      });
      (d?.data?.chunks||[]).forEach(ch=>{
        const en=!isViet(ch.text||"")&&ch.text?ch.text:ch.meaning;
        const vi=isViet(ch.text||"")?ch.text:ch.meaning;
        if(en&&vi&&!isViet(en)&&en.length>1)
          pool.push({word:en,display:en,meaning:vi,level:"",grammar:ch.grammar||"",sentence:sent,example:""});
      });
    });
  } else if(src==="saved"){
    (getStats().savedWordsList||[]).filter(w=>!isViet(w.lemma||w.key))
      .forEach(w=>pool.push({word:w.lemma||w.key,display:w.lemma||w.key,meaning:w.meaning,level:w.level||"",grammar:"",sentence:"",example:""}));
  } else if(src==="viewed"){
    (getStats().viewedWordsList||[]).filter(w=>!isViet(w.lemma||w.key))
      .forEach(w=>pool.push({word:w.lemma||w.key,display:w.lemma||w.key,meaning:w.meaning,level:w.level||"",grammar:"",sentence:"",example:""}));
  } else if(src==="sent"){
    (getStats().savedSentList||[]).filter(x=>x.text&&!isViet(x.text))
      .forEach(x=>pool.push({word:x.text,display:x.text,meaning:"",level:"",grammar:"",sentence:x.text,example:""}));
  }
  const seen=new Set();
  return pool.filter(w=>{const k=w.word.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
}
function collectPoolFromFolder(folderId){
  function isViet(s){return /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s||"");}
  const h=JSON.parse(localStorage.getItem("history_en8")||"[]").filter(x=>x.folderId===folderId);
  let pool=[];
  h.slice(0,50).forEach(item=>{
    if(item.result){
      const tmp=document.createElement("div");tmp.innerHTML=item.result;
      tmp.querySelectorAll("[data-meaning]").forEach(el=>{
        const w=el.dataset?.lemma||el.dataset?.key||"";
        const m=el.dataset?.meaning||"";
        if(w&&m&&w.length>1&&!isViet(w))
          pool.push({word:w,display:w,meaning:m,level:el.dataset?.level||item.level||"",grammar:"",sentence:item.text||"",example:""});
      });
    }
  });
  const seen=new Set();
  return pool.filter(w=>{const k=w.word.toLowerCase();if(seen.has(k))return false;seen.add(k);return true;});
}
function confirmCreateExam(){
const creditCost=10;
const s=getStats();
if((s.credits||0)<creditCost){alert("🔴 Hết credit. Vui lòng nạp thêm credit.");return;}

if(_examKind==="de"){
  if(!_examFolderId){alert("Vui lòng chọn 1 folder.");return;}
  const folder=mentorFolders.find(f=>f.id===_examFolderId);
  if(!folder){alert("Folder không hợp lệ.");return;}
  const MIN_SAVED_CONTENT=10;
  const savedCount=countHistoryInFolder(_examFolderId);
  if(savedCount<MIN_SAVED_CONTENT){alert(`🔒 Cần ít nhất ${MIN_SAVED_CONTENT} nội dung trong folder "${folder.name}" mới được tạo đề (hiện có ${savedCount}). Hãy phân tích và lưu thêm nội dung vào folder này.`);return;}
  const pool=collectPoolFromFolder(_examFolderId);
  if(pool.length<5){alert("Cần ít nhất 5 từ/cụm trong folder này. Phân tích thêm nội dung.");return;}
  const domLevel=folder.level;
  const N=domLevel==="A1-A2"?10:30;
  const modeLabel=_examType==="ptth"?"PTTH":"IELTS";
  if(!confirm(`Tạo đề ${modeLabel} (${N} câu, level ${domLevel}) từ folder "${folder.name}"?\nTốn: ${creditCost} credit | Số dư: ${s.credits||0}`))return;
  s.credits=(s.credits||0)-creditCost;
  saveStats(s);renderStats();
  closeTest();
  createExamWithAI(pool,domLevel,N,{kind:"de",folderId:_examFolderId});
} else {
  const examSrc=document.querySelector("[data-src].active")?.dataset.src||"current";
  const pool=collectPool(examSrc);
  if(pool.length<5){alert("Cần ít nhất 5 từ/cụm. Phân tích thêm nội dung.");return;}
  const domLevel=getDomLevel(pool)||"B1";
  const N=domLevel==="A1-A2"?10:30;
  if(!confirm(`Tạo bài ôn từ vựng (${N} câu, level ${domLevel})?\nTốn: ${creditCost} credit | Số dư: ${s.credits||0}`))return;
  s.credits=(s.credits||0)-creditCost;
  saveStats(s);renderStats();
  closeTest();
  const reviewFolderId=getReviewFolderId(normalizeLibLevel(domLevel));
  createExamWithAI(pool,domLevel,N,{kind:"bai_kiem_tra",folderId:reviewFolderId});
}
}
async function createExamWithAI(pool,domLevel,N,meta){
const isVocab=meta.kind==="bai_kiem_tra";
const isIELTS=!isVocab&&_examType==="ielts";
const isPTTH=!isVocab&&_examType==="ptth";
const duration=isIELTS?60:isPTTH?45:30;
const statusDiv=document.createElement("div");
statusDiv.style.cssText="position:fixed;bottom:80px;right:20px;background:#1a3c6e;color:#fff;padding:12px 16px;border-radius:8px;font-size:13px;z-index:9999;box-shadow:0 4px 16px rgba(0,0,0,.3)";
statusDiv.id="examStatus";
document.body.appendChild(statusDiv);
const setStatus=(msg)=>{statusDiv.innerHTML=msg;};
const sampleWords=pool.sort(()=>Math.random()-.5).slice(0,50);
const sentences=[...new Set(pool.map(w=>w.sentence).filter(s=>s&&s.length>15))].slice(0,12);
const wordList=sampleWords.slice(0,40).map(w=>`"${w.display}"(${w.meaning})${w.grammar?`[${w.grammar}]`:""}`).join(", ");
// Gọi qua Worker (action generate_exam_legacy) — API key + model nằm ở server, frontend không thấy.
const callAPI=async(prompt,tok=3200)=>{
  const r=await fetch(WORKER_URL,{
    method:"POST",
    headers:{"Content-Type":"application/json","X-App-Secret":APP_SECRET},
    body:JSON.stringify({
      action:"generate_exam_legacy",
      max_tokens:Math.max(tok,4000),
      messages:[
        {role:"system",content:"You are an expert English exam creator. Return ONLY valid JSON. Never truncate output."},
        {role:"user",content:prompt}
      ]
    })
  });
  const result=await r.json();
  // giữ nguyên shape cũ để parseResult() phía dưới không cần sửa
  return {choices:[{message:{content: result.content || "{}"}}]};
};
const parseResult=(r,name)=>{
const raw=r?.choices?.[0]?.message?.content||"{}";
try{
const p=JSON.parse(raw);
if(p.sections)return p;
if(p.parts&&p.parts[0])return p.parts[0];
if(p.name)return p;
}catch{
const m=raw.match(/\{[\s\S]*\}/);
if(m)try{const p2=JSON.parse(m[0]);if(p2.sections||p2.name)return p2;}catch{}
}
return {name,sections:[{title:"Section",questions:[]}]};
};
try{
let allParts=[];
let examTitle="";
if(isVocab){
// ══ VOCAB DRILL MODE ══════════════════════════════════
// Purpose: memorize words, understand sentences, listen, read
examTitle=`Bài ôn · ${domLevel} · ${new Date().toLocaleDateString("vi-VN")}`;
setStatus("⏳ Đang tạo bài ôn từ vựng...");
const passage=sentences.slice(0,6).join(" ")||(sampleWords.slice(0,5).map(w=>w.example||"").filter(Boolean).join(" "));
const vocabN=Math.ceil(N*0.35);
const readN=Math.floor(N*0.35);
const listenN=N-vocabN-readN;
const vocabPrompt=`You are an English vocabulary teacher creating quiz questions in ENGLISH for a Vietnamese learner at ${domLevel} level.
IMPORTANT: ALL questions, options, and question text must be in ENGLISH. Only explanations are in Vietnamese.
Vocabulary to test: ${wordList}

Create EXACTLY ${vocabN} questions mixing these types:
1. meaning_in_context: Use the word in an English sentence → "In the sentence '...', what does '[word]' mean?" → 4 English meaning options
2. usage: "Which sentence correctly uses '[word]'?" → 4 English sentence options (only 1 grammatically/semantically correct)
3. collocation: "Which word best completes: '[word] ___ [context]'?" → 4 English word options
4. word_form: "Choose the correct form: The ___ of the building was impressive. (BUILD)" → 4 forms: build/building/built/builder

STRICT RULES:
- Questions MUST be in English
- Options MUST be in English
- Distractors must be plausible English words/phrases (not random)
- Use actual vocabulary from the list above
- EVERY question: exactly 4 options ["A. ...","B. ...","C. ...","D. ..."], correct=letter A/B/C/D
- explanation: Vietnamese explanation of why the answer is correct

Return JSON: {"name":"Phần 1: Từ vựng","sections":[{"title":"VOCABULARY PRACTICE","instruction":"Choose the best answer for each question.","questions":[{"num":1,"type":"mcq","question":"In the sentence 'She found her roots in her hometown', what does 'roots' mean?","options":["A. plants","B. origins and identity","C. directions","D. memories"],"correct":"B","correct_text":"origins and identity","explanation":"'Roots' trong ngữ cảnh này có nghĩa là nguồn gốc, bản sắc — nơi mình thuộc về."}]}]}`;

const readPrompt=`Create EXACTLY ${readN} reading comprehension questions in ENGLISH based on this passage.
PASSAGE: "${passage}"

Question types to mix:
- inference MCQ: "What can we infer about X?" — answer NOT stated literally, requires reasoning
- detail MCQ: "According to the passage, what does X do?" — answer stated in passage
- vocabulary_in_context: "In paragraph X, the word '___' is closest in meaning to:" → 4 English options
- main_idea MCQ: "What is the main idea of the passage?" → 4 options
- tfng: Write a paraphrased statement (NOT copied from passage) → student answers True/False/Not Given

RULES: All questions in English. Questions require reading — cannot answer from general knowledge alone. MCQ: 4 English options. tfng: correct="True"/"False"/"Not Given". Explanation in Vietnamese.
Return JSON: {"name":"Phần 2: Đọc hiểu","sections":[{"title":"READING COMPREHENSION","instruction":"Read the passage and answer the questions.","passage":"${passage.replace(/"/g,"'")}","passageTitle":"Reading Passage","questions":[{"num":1,"type":"mcq","question":"According to the passage, what can a hometown provide?","options":["A. Financial support","B. A sense of roots and belonging","C. Educational opportunities","D. Career advancement"],"correct":"B","correct_text":"A sense of roots and belonging","explanation":"Đoạn văn nói hometown là nơi bạn tìm thấy nguồn gốc (roots) — đây là lợi ích tinh thần."}]}]}`;

const listenSents=sentences.slice(0,listenN+2).filter(s=>s&&s.trim().length>10);
const listenPrompt=`Create EXACTLY ${listenN} listening comprehension questions for ${domLevel} level English learners.

For EACH question:
1. Write audio_text: a natural English sentence (1-3 sentences) that a student will HEAR
2. Write question: ask about the CONTENT of what was heard (student has NOT seen audio_text yet)
3. Write 4 English options — exactly one correct based on audio_text
4. Student must LISTEN to answer — question alone is not enough

Use these sentences as inspiration for audio content:
${listenSents.map((s,i)=>`${i+1}. "${s}"`).join("\n")}

Question variety — mix these:
- comprehension: "What did the speaker say about X?" → 4 options about the audio content
- gap_from_audio: "Listen. The _____ is/was [detail]." → 4 options for the blank (the answer is in audio)  
- inference_audio: "From what you heard, what can you conclude?" → 4 reasoning options
- detail: "According to the audio, which statement is correct?" → 4 options (3 contradict audio, 1 matches)

STRICT RULES:
- type="listening" for ALL questions
- audio_text MUST be a complete natural English sentence/dialogue
- question text must NOT reveal the answer — ask about content without giving it away
- passage_ref = null for ALL listening questions
- options: exactly 4 English items ["A. ...","B. ...","C. ...","D. ..."]
- correct = letter A/B/C/D
- explanation in Vietnamese

Return JSON: {"name":"Phần 3: Nghe","sections":[{"title":"LISTENING COMPREHENSION","instruction":"Listen to the audio and answer each question. Press Play to listen.","questions":[{"num":1,"type":"listening","question":"What does the speaker say about the iPhone?","audio_text":"The iPhone changed everything. It was the first phone that could do so many things at once — calls, music, photos, and the internet.","options":["A. It was the first phone to make calls","B. It could perform many functions at once","C. It was only good for music","D. It replaced all computers"],"correct":"B","correct_text":"It could perform many functions at once","explanation":"Audio nói iPhone có thể làm nhiều thứ cùng lúc (calls, music, photos, internet) → đáp án B đúng."}]}]}`;
setStatus("⏳ Đang tạo 3 phần song song...");
const [rVocab,rRead,rListen]=await Promise.all([
callAPI(vocabPrompt,2500),
callAPI(readPrompt,2500),
callAPI(listenPrompt,2000)
]);
allParts=[
parseResult(rVocab,"Phần 1: Từ vựng"),
parseResult(rRead,"Phần 2: Đọc hiểu"),
parseResult(rListen,"Phần 3: Nghe"),
];
}else{
// ══ IELTS / PTTH MODE ══════════════════════════════════
examTitle=`${isIELTS?"IELTS":"PTTH"} · ${domLevel} · ${new Date().toLocaleDateString("vi-VN")}`;
const lvC={"A1-A2":"Simple present/past only, basic vocab, short sentences. NO inference/conditionals/passive.",A2:"Present/past/future/continuous, going to, can/could. Simple inference OK.",
"B2":"All tenses, passive, conditionals 1-2, phrasal verbs. Inference, transform, error correction required."}[domLevel]||"A2 level";
const ANTI=`CRITICAL RULES: (1) ALL questions, options, passages must be in ENGLISH — never Vietnamese. Only "explanation" field is Vietnamese. (2) Never put answer word in question. (3) Gap-fill tests GRAMMAR not vocabulary recognition.`;
// ── IELTS prompt (Cambridge Academic/General style) ──────────
const mkIELTS=(pd)=>`You are an expert IELTS examiner from Cambridge. Create EXACTLY ${pd.count} AUTHENTIC exam questions.

STUDENT DATA:
Vocabulary: ${wordList}
Sentences: ${sentences.join(" | ")}
Level: ${domLevel}

${ANTI}

SECTION: ${pd.name}
${pd.instructions}

CAMBRIDGE IELTS QUESTION PATTERNS (follow these formats exactly):

VOCABULARY IN CONTEXT (for Part 1):
Q: "The project was _____ due to lack of funding, leaving hundreds of workers unemployed."
Options: A. called off  B. set up  C. put forward  D. carried out
→ Tests collocation + phrasal verb. NOT obvious from context.

GRAMMAR/TENSE (for Part 1):
Q: "By the time the rescue team arrived, the survivors _____ for nearly twelve hours."
Options: A. wait  B. were waiting  C. had been waiting  D. have waited
→ Perfect aspect, time expression triggers correct tense.

ERROR IDENTIFICATION (for Part 1):
Q: "The new policy (A)have been (B)implemented by the government (C)to reduce (D)unemployment rates."
Options: A  B  C  D  (A is wrong: should be "has been")

READING INFERENCE (for Part 2 — passage-based):
Passage: "Hometown is more than a location — it is a repository of identity, the place where personal history intersects with collective memory."
Q: "What does the author suggest about hometowns?"
Options: A. They change with time  B. They hold deep personal significance  C. They are found everywhere  D. They can be replaced
→ Requires inference, not literal extraction.

T/F/NG (for Part 2):
Statement: "Hometowns remain unchanged regardless of circumstances."
→ Must be paraphrased from passage, not copied. Answer based on what passage says/doesn't say.

LISTENING — comprehension (for Part 3):
audio_text: "The iPhone's introduction of Siri marked a significant shift in human-computer interaction. Users could now speak naturally to their devices and receive intelligent responses."
Q: "What does the speaker say was significant about Siri?"
Options: A. It made phones cheaper  B. It changed how humans interact with computers  C. It replaced keyboards  D. It improved camera quality
→ Question doesn't reveal audio content.

WORD ORDER (for Part 4):
correct: "Despite the difficulties she faced, she never gave up hope."
→ Complex sentence with subordinating clause. 7+ words.

WRITING REWRITE (for Part 4):
Q: "Rewrite: 'Although he works hard, he earns very little.' using DESPITE"
explanation: "Despite working hard, he earns very little."

JSON RULES (strictly follow):
- type="mcq": 4 options, correct=letter, NO [BLANK] in question
- type="gap_fill" with options: [BLANK] in question, 4 options, correct=letter
- type="tfng": options=[], correct="True"/"False"/"Not Given"
- type="listening": audio_text MUST be complete English sentence (15+ words), options=4 or [] for tfng
- type="word_order": correct=full sentence 7+ words, options=[]
- type="writing": correct="open", options=[]
- passage_ref: sentence from passage for tfng context only

Return ONLY JSON: {"name":"${pd.name}","sections":[{"title":"${pd.sectionTitle}","instruction":"${pd.instruction}","passage":${pd.needsPassage?'"Write a sophisticated 8-sentence ENGLISH passage using vocabulary above. Include complex sentences, varied structure, academic register."':"null"},"passageTitle":${pd.needsPassage?'"Reading Passage"':"null"},"questions":[{"num":1,"type":"TYPE","question":"...","passage_ref":null,"options":["A. ...","B. ...","C. ...","D. ..."],"correct":"B","correct_text":"...","audio_text":null,"explanation":"Giải thích tiếng Việt — tại sao đúng + quy tắc quan trọng"}]}]}`;

const mkPTTH=(pd)=>`You are a Vietnamese high school English exam expert (giáo viên ra đề THPT quốc gia). Create EXACTLY ${pd.count} authentic questions following official Bộ GD&ĐT format.

STUDENT DATA:
Vocabulary: ${wordList}
Sentences: ${sentences.join(" | ")}
Level: ${domLevel}

ANTI-CHEAT: ALL questions/options in English. explanation in Vietnamese. Never put answer in question.

SECTION: ${pd.name}
${pd.instructions}

OFFICIAL THPT EXAM PATTERNS (copy these formats exactly):

PHÁT ÂM (âm khác nhau):
Q: "Which word has the underlined part pronounced DIFFERENTLY from the others?"
A. <u>ch</u>ange   B. <u>ch</u>emist   C. <u>ch</u>ild   D. <u>ch</u>air
→ B is different (k sound vs ch sound). Use vocabulary from student data.

TRỌNG ÂM (stress khác):
Q: "Which word has a DIFFERENT stress pattern?"
A. 'worker   B. 'teacher   C. 'student   D. re'cord
→ D stresses 2nd syllable. Find real words from vocabulary.

TỪ VỰNG ĐIỀN VÀO CÂU (chọn từ phù hợp):
Q: "A ______ is a place where you can go back to remember your past."
A. hometown   B. workplace   C. hospital   D. library
→ Use actual vocabulary in sentence context.

NGỮ PHÁP-THÌ:
Q: "She ______ in this city since she was born."
A. lives   B. lived   C. has lived   D. is living
→ Since = present perfect.

PHÁT HIỆN LỖI:
Q: "She <u>don't</u> <u>like</u> <u>going to</u> <u>the market</u> every day."
options: ["A. don't","B. like","C. going to","D. the market"] correct="A" (should be "doesn't")

VIẾT LẠI - TRANSFORMATION:
Q: "Although he is old, he still works hard. → He works hard ______ his old age."
A. despite   B. because   C. since   D. though
→ 4 complete options, test connector.

CLOZE READING (for Part 3 — passage with numbered blanks):
Passage has [1], [2]... blanks. Each blank is a question:
Q: "Choose the best word for blank [1]: 'A hometown is a place [1] you always belong.'"
A. which   B. where   C. who   D. when
→ Tests relative clause.

ĐỌC HIỂU - COMPREHENSION:
Q: "According to the passage, what makes a hometown special?"
A. Its size   B. Its financial opportunities   C. Its emotional connection   D. Its location
→ Requires reading inference.

JSON RULES: mcq=4opts, gap_fill=[BLANK]+4opts or no opts (type-in), tfng=no opts, word_order=no opts, writing=correct="open"+no opts.
Return ONLY JSON: {"name":"${pd.name}","sections":[{"title":"${pd.sectionTitle}","instruction":"${pd.instruction}","passage":${pd.needsPassage?'"Write an 8-sentence English passage on topic from student data. Use varied sentence structures."':"null"},"passageTitle":${pd.needsPassage?'"Đọc hiểu"':"null"},"questions":[{"num":1,"type":"TYPE","question":"...","passage_ref":null,"options":["A. ...","B. ...","C. ...","D. ..."],"correct":"A","correct_text":"...","audio_text":null,"explanation":"Giải thích tiếng Việt — đáp án + lý do + quy tắc"}]}]}`;

const mkPart=isIELTS?mkIELTS:mkPTTH;
// domLevel B1/B2 -> mỗi phần 10 câu (tổng 40) thay vì 8/8/7/7 (tổng 30) của A1-A2.
// CHỈ áp dụng cho "Đề" (nhánh isIELTS/isPTTH này) — nhánh "Bài Kiểm Tra" (isVocab) ở
// trên KHÔNG đụng tới. Thời gian làm bài (duration) giữ nguyên không đổi.
const isHigherLevel=domLevel==="B1"||domLevel==="B2";
const partDefs=isIELTS?[
{name:"Part 1: Vocabulary & Grammar",count:isHigherLevel?10:8,sectionTitle:"VOCABULARY AND GRAMMAR",
instruction:"Choose the best answer A, B, C or D for each question.",
types:"mcq",needsPassage:false,isListen:false,
instructions:`All ${isHigherLevel?10:8} questions are type="mcq" with 4 options. NO [BLANK] in questions — ask directly.
Q1-2: Vocabulary meaning/usage — "In the sentence '...', the word '___' is closest in meaning to:" or "Which sentence uses '[word]' correctly?"
Q3-4: Tense choice — "She _____ in this city for ten years." then give 4 tense options A/B/C/D (no [BLANK], just the stem sentence then options)
Q5-6: Error identification — Show full sentence with 4 parts underlined using <u>text</u> tags. Ask "Which underlined part (A, B, C or D) contains an error?" Then provide options: A.[underlined text A] B.[underlined text B] C.[underlined text C] D.[underlined text D]. correct=the letter of the wrong part. NEVER put (A)(B)(C)(D) inline in the sentence — use <u> tags instead. Example: question="She <u>has went</u> to <u>the market</u> <u>every day</u> <u>last week</u>. Which part has an error?" options=["A. has went","B. the market","C. every day","D. last week"] correct="A"
Q7: Word form — "(BUILD) The _____ of the new bridge took two years." 4 form options
Q8: Collocation/phrasal verb — "The meeting was called _____ at the last minute." 4 preposition options${isHigherLevel?`
Q9: SECOND vocabulary meaning/usage item — same format as Q1-2, use a DIFFERENT word from student data.
Q10: SECOND word-form item — same format as Q7, use a DIFFERENT word from student data.`:""}`},
{name:"Part 2: Reading Comprehension",count:isHigherLevel?10:8,sectionTitle:"READING COMPREHENSION",
instruction:"Read the passage carefully and answer the questions.",
types:"mcq|tfng|gap_fill",needsPassage:true,isListen:false,
instructions:`Write a ${isHigherLevel?"8-10":"6-8"} sentence ENGLISH passage. Then ${isHigherLevel?10:8} questions:
Q1-3: type="mcq", 4 options, NO [BLANK] — ask about passage meaning/inference
Q4-5: type="tfng", passage_ref=relevant sentence, options=[], correct="True"/"False"/"Not Given"
Q6-7: type="gap_fill", sentence with [BLANK], 4 options (grammar test), correct=letter
Q8: type="mcq", vocabulary in context, 4 English meaning options${isHigherLevel?`
Q9: type="mcq", detail question — ask about a specific fact stated in the passage, 4 options, NO [BLANK]
Q10: type="tfng", a SECOND paraphrased statement (different from Q4-5), options=[], correct="True"/"False"/"Not Given"`:""}`},
{name:"Part 3: Listening Practice",count:isHigherLevel?10:7,sectionTitle:"LISTENING COMPREHENSION",
instruction:"Listen to the audio and answer the questions. Press Play to listen.",
types:"listening",needsPassage:false,isListen:true,
instructions:`ALL ${isHigherLevel?10:7} questions: type="listening". EVERY question MUST have audio_text (complete English sentence, 10+ words). passage_ref=null always.

${domLevel==="B2"?`B1-B2 FORMAT — ONE shared audio for ALL ${isHigherLevel?10:7} questions:
Write ONE rich audio passage (${isHigherLevel?"6-8":"4-6"} sentences, ${isHigherLevel?"90-120":"60-80"} words) covering vocabulary from student data.
Set this SAME text as audio_text on EVERY question.
Create ${isHigherLevel?10:7} different questions all about THIS ONE audio:
- ${isHigherLevel?6:3}x comprehension MCQ: "According to the audio..." / "What does the speaker mention about...?"
- 2x inference MCQ: "What can we infer from the audio?" / "Why does the speaker say...?"
- 1x T/F/NG: statement about audio content, options=[], correct="True"/"False"/"Not Given"
- 1x gap from audio: "The speaker says the ___ is important", 4 word options`:`A1/A2 FORMAT — Each question has its OWN SHORT audio:
Each audio_text = 1 simple sentence (10-15 words) from student data.
Every question uses a DIFFERENT audio_text.
Types: comprehension MCQ (what does the speaker say?), T/F about audio, gap from audio.${isHigherLevel?" Repeat this same mix of types to reach the required total.":""}`}

ALL questions: audio_text NEVER null/empty. Question text must NOT reveal the audio answer.`},
{name:"Part 4: Writing Skills",count:isHigherLevel?10:7,sectionTitle:"WRITING SKILLS",
instruction:"Complete the writing tasks below. Write your answers in English.",
types:"word_order|writing",needsPassage:false,isListen:false,
instructions:`${isHigherLevel?10:7} questions. NO MCQ. Use student's ACTUAL sentences from data.
Q1-2: type=word_order. Take an actual sentence from student data (6+ words), scramble it. correct=original sentence. options=[].
Q3: type=writing. 'Rewrite using ALTHOUGH: [actual sentence from data]'. correct=open. options=[].
Q4: type=writing. 'Rewrite using DESPITE/BECAUSE/SO THAT: [another sentence]'. correct=open. options=[].
Q5: type=writing. 'Translate to English: [Vietnamese version of a student sentence]'. correct=open. options=[].
Q6: type=writing. 'Write 2-3 sentences about [topic from data] using: [3 vocab words]'. correct=open. options=[].
Q7: type=writing. 'Complete this sentence: [partial sentence from data] ___'. correct=open. options=[].${isHigherLevel?`
Q8: type=word_order. Take ANOTHER actual sentence from student data (different from Q1-2, 6+ words), scramble it. correct=original sentence. options=[].
Q9: type=writing. 'Rewrite using SO...THAT/SUCH...THAT: [another sentence from data]'. correct=open. options=[].
Q10: type=writing. 'Write 2-3 sentences about [a DIFFERENT topic from data] using: [3 different vocab words]'. correct=open. options=[].`:""}
All explanations show model answer in Vietnamese.`}
]:[
// ── PTTH (THPT Quốc Gia) partDefs ──────────────────────────
{name:"Phần 1: Ngữ âm & Từ vựng",count:isHigherLevel?10:8,sectionTitle:"PHONETICS AND VOCABULARY",
instruction:"Choose the best answer A, B, C or D to complete each sentence.",
types:"mcq",needsPassage:false,isListen:false,
instructions:`${isHigherLevel?10:8} questions, all type="mcq", 4 options, NO [BLANK].
Q1: Phát âm — "Which word has the underlined part pronounced DIFFERENTLY from the others?" Use vocabulary from data. Underline with <u>letters</u>. 4 words as options.
Q2: Trọng âm — "Which word has a DIFFERENT stress pattern from the others?" 4 words, mark stress with '.
Q3-5: Từ vựng điền vào câu — Complete the sentence: "[sentence using vocabulary context]" A.[word] B.[word] C.[word] D.[word] — Test meaning/collocation.
Q6-7: Dạng từ — "(BUILD) The _____ of the new school was completed last year." 4 word forms.
Q8: Phrasal verb/collocation — from student vocabulary, test collocation or phrasal verb.${isHigherLevel?`
Q9: Từ vựng điền vào câu — thêm 1 câu tương tự Q3-5, dùng từ vựng KHÁC trong data.
Q10: Dạng từ — thêm 1 câu tương tự Q6-7, dùng từ gốc KHÁC.`:""}`},
{name:"Phần 2: Ngữ pháp & Cấu trúc",count:isHigherLevel?10:8,sectionTitle:"GRAMMAR",
instruction:"Choose the best answer A, B, C or D for each question.",
types:"mcq",needsPassage:false,isListen:false,
instructions:`${isHigherLevel?10:8} questions, all type="mcq", 4 options, NO [BLANK] in question text.
Q1-3: Thì động từ — Sentence using student vocabulary, ask which tense is correct. Options are 4 different tenses.
Example: "By the time she arrived, they ______ for an hour." A.wait B.waited C.had been waiting D.have waited
Q4-5: Phát hiện lỗi — Full sentence with 4 parts underlined using <u>tags</u>. Provide 4 options listing the underlined parts. correct=wrong letter. Example: question="She <u>has went</u> to <u>the market</u> <u>every day</u> <u>last week</u>." options=["A. has went","B. the market","C. every day","D. last week"] correct="A". NEVER use (A)(B) inline.
Q6-7: Viết lại câu — "He is too old to run." → "He is so old ______" + 4 complete sentence options.
Q8: Câu điều kiện/bị động/mệnh đề quan hệ — test one structure using student vocabulary.${isHigherLevel?`
Q9: Thì động từ — thêm 1 câu tương tự Q1-3, dùng ngữ cảnh KHÁC.
Q10: Câu điều kiện/bị động/mệnh đề quan hệ — thêm 1 câu, test cấu trúc KHÁC Q8.`:""}`},
{name:"Phần 3: Đọc hiểu",count:isHigherLevel?10:7,sectionTitle:"READING COMPREHENSION",
instruction:"Read the passage and answer the questions.",
types:"mcq|gap_fill",needsPassage:true,isListen:false,
instructions:`Write a ${isHigherLevel?"8-10":"6-8"} sentence English passage. Then ${isHigherLevel?10:7} questions:
Q1-2: Điền vào chỗ trống (cloze) — type="gap_fill", [BLANK] in passage sentence, 4 word choices, test grammar/connector. correct=letter.
Q3-5: Đọc hiểu — type="mcq", ask about passage meaning, inference, or detail. 4 options, NO [BLANK].
Q6-7: Tìm từ đồng nghĩa/gần nghĩa — "In paragraph X, the word '___' is closest in meaning to:" 4 English options.${isHigherLevel?`
Q8: Điền vào chỗ trống (cloze) — thêm 1 câu tương tự Q1-2, blank KHÁC trong đoạn văn.
Q9: Đọc hiểu — thêm 1 câu tương tự Q3-5, hỏi chi tiết/suy luận KHÁC.
Q10: Tìm từ đồng nghĩa/gần nghĩa — thêm 1 câu tương tự Q6-7, từ KHÁC.`:""}`},
{name:"Phần 4: Viết",count:isHigherLevel?10:7,sectionTitle:"WRITING",
instruction:"Complete the writing tasks. Write your answers in English.",
types:"word_order|writing",needsPassage:false,isListen:false,
instructions:`EXACTLY ${isHigherLevel?10:7} questions using student's ACTUAL data. ALL in English. NO MCQ.
Q1-2: type="word_order" — Take an ACTUAL sentence from student data. Scramble its words. correct=original sentence. options=[].
Q3: type="writing" — "Rewrite using ALTHOUGH: [actual sentence from student data that shows contrast]" correct="open". options=[]. explanation=model answer.
Q4: type="writing" — "Rewrite using BECAUSE/SINCE: [actual sentence from student data showing reason]" correct="open". options=[]. explanation=model answer.
Q5: type="writing" — "Translate to English: [Vietnamese sentence closely related to student vocabulary]" correct="open". options=[]. explanation=English translation.
Q6: type="writing" — "Write 2-3 English sentences about [topic found in student data]. Use: [3 words from vocabulary]" correct="open". options=[]. explanation=sample answer.
Q7: type="writing" — "Complete this English sentence in a meaningful way: [beginning of sentence from student data] ___" correct="open". options=[]. explanation=suggested completion.${isHigherLevel?`
Q8: type="word_order" — Take ANOTHER actual sentence from student data (different from Q1-2). Scramble its words. correct=original sentence. options=[].
Q9: type="writing" — "Rewrite using SO...THAT/SUCH...THAT: [another sentence from student data]" correct="open". options=[]. explanation=model answer.
Q10: type="writing" — "Write 2-3 English sentences about [a DIFFERENT topic from data]. Use: [3 different vocabulary words]" correct="open". options=[]. explanation=sample answer.`:""}`},
];
setStatus("⏳ Đang tạo 4 phần thi song song...");
const results=await Promise.all(partDefs.map(pd=>callAPI(mkPart(pd),3000)));
allParts=results.map((r,i)=>parseResult(r,partDefs[i].name));
}
setStatus("✅ Đang lưu đề...");
if(!allParts.length)throw new Error("AI không trả về đề hợp lệ");
const totalQ=allParts.reduce((a,p)=>a+(p.sections||[]).reduce((b,s)=>b+(s.questions?.length||0),0),0);
const finalFolderId = meta.kind==="de" ? await getOrCreateExamSubFolder(meta.folderId) : meta.folderId;
if(!finalFolderId) throw new Error("Không xác định được folder để lưu đề.");
const { data: examRow, error: insErr } = await supabase.from("mentor_exams").insert({
  mentor_id: currentMentor.id, folder_id: finalFolderId, title: examTitle,
  kind: meta.kind, exam_type: isVocab?"vocab":_examType, level: domLevel,
  duration_minutes: duration, questions_count: totalQ, payload: { parts: allParts },
}).select().single();
if(insErr) throw new Error("Lỗi lưu đề: "+insErr.message);
mentorExams.unshift(examRow);
statusDiv.remove();
const modeLabel2=isVocab?"bài ôn từ vựng":isIELTS?"đề IELTS":"đề PTTH";
if(confirm(`✅ Đã tạo ${modeLabel2} "${examTitle}" (${totalQ} câu).\nMở bài thi ngay?`))examOpen(examRow.id);
}catch(err){
statusDiv.remove();
alert("❌ Lỗi tạo đề: "+err.message+"\nCredit đã hoàn trả.");
const s2=getStats();s2.credits=(s2.credits||0)+10;saveStats(s2);renderStats();
}
}function openTest(){
  if(_examKind==="de")populateExamFolderSelect();
  updateExamCreditInfo();
  loadSavedExamsList();
  document.getElementById("testOverlay").classList.add("open");
}
function closeTest(){document.getElementById("testOverlay").classList.remove("open");}
function buildCurrentTest(){}
function checkAnswers(){}
function showAnswers(){}
function ieltsPick(){}
function ieltsSpeak(){}
function loadSavedSentPanel() {
  const s = getStats();
  const list = s.savedSentList||[];
  const el = document.getElementById("savedSentContent");
  if(!el) return;
  el.innerHTML = list.length
    ? list.map(sent=>`<div style="padding:9px 4px;border-bottom:1px solid #eaf4fb">
        <div style="font-size:13px;color:#0a2540;margin-bottom:5px;line-height:1.5">"${sent.text}"</div>
        <div style="display:flex;justify-content:flex-end;gap:8px">
          <button onclick="speakSavedSent(this)" data-text="${(sent.text||'').replace(/"/g,'&quot;')}" style="background:none;border:none;cursor:pointer;font-size:16px;color:#5dade2;padding:0" title="Nghe">🔊</button>
          <button onclick="deleteSavedSent('${sent.key}')" style="background:none;border:none;cursor:pointer;font-size:16px;color:#dc3545;padding:0" title="Xóa">🗑</button>
        </div>
      </div>`).join("")
    : '<div style="color:#aaa;font-size:13px;padding:8px">Chưa lưu câu nào.<br>Nhấn ☆ trên câu để lưu.</div>';
}
function speakSavedSent(btn) {
  const text = btn.getAttribute("data-text");
  if(!text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang="en-US"; u.rate=0.92; applyVolume(u);
  speechSynthesis.speak(u);
}
function deleteSavedSent(key) {
  const s = getStats();
  s.savedSentList = (s.savedSentList||[]).filter(x=>x.key!==key);
  saveStats(s); updateBadges(); loadSavedSentPanel();
}
function toggleWordItem(wid, key, lemma, meaning, level) {
  const item=document.getElementById("wi_"+wid);
  if(!item)return;
  const isOpen=item.classList.contains("open");
  const uid=wid.split("_").slice(0,-1).join("_");
  document.querySelectorAll(`[id^="wi_${uid}_"]`).forEach(el=>el.classList.remove("open"));
  if(!isOpen){
    item.classList.add("open");
    trackViewedWord(key,lemma,meaning,level);
  }
}
const AI_SENT_TIPS = {
  "Excuse me, are you American?":"Câu hỏi Yes/No dùng <b>be</b> đảo lên đầu. \"Excuse me\" mở đầu lịch sự khi tiếp cận người lạ. Cấu trúc: <i>Are + subject + adjective?</i>",
  "No. I'm from Vietnam.":"Trả lời ngắn \"No.\" rồi giải thích. <b>I'm = I am</b>. Cấu trúc <i>I'm from + nơi chốn</i> — mẫu giới thiệu xuất xứ rất phổ biến.",
  "Do you speak English?":"Câu hỏi Yes/No dùng trợ động từ <b>do</b>. <b>Do</b> ở đây không có nghĩa \"làm\" — chỉ là trợ từ. \"speak English\" là cách nói chuẩn.",
  "Where do you want to go?":"Câu hỏi Wh-word với <b>where</b>. Cấu trúc: <i>Where + do + subject + verb?</i>. \"Want to\" = muốn.",
  "I'd like to go to a Viet Nam restaurant.":"<b>I'd like to</b> = muốn (lịch sự hơn \"I want\"). Cấu trúc: <i>I'd like to + verb nguyên mẫu</i>.",
  "No, I don't, but I like Bun Cha.":"Phủ định ngắn <b>I don't</b>. Dùng <b>but</b> để đối lập. Cấu trúc: <i>No, I don't, but I + verb...</i>",
};
const AI_WORD_TIPS = {
  "Excuse me":"\"Excuse me\" là cụm cố định tiếp cận lịch sự. Khác với \"Sorry\" (xin lỗi khi mắc lỗi). Dùng trước câu hỏi với người lạ.",
  "are":"\"Are\" ở đây là trợ động từ tạo câu hỏi Yes/No, không phải động từ chính. Đảo lên đầu câu: <i>Are + subject + ...?</i>",
  "American":"\"American\" vừa là danh từ (người Mỹ) vừa là tính từ. Ví dụ: <i>an American car</i> (xe Mỹ) vs <i>She is an American</i>.",
  "I'm":"\"I'm\" = \"I am\" viết tắt. Dùng trước tính từ, danh từ, hoặc nơi chốn: <i>I'm happy / I'm a student / I'm from Vietnam</i>.",
  "do":"\"Do\" ở đây là trợ động từ tạo câu hỏi — KHÔNG có nghĩa \"làm\". Đảo lên đầu để hỏi Yes/No.",
  "speak":"\"Speak\" + ngôn ngữ là cách nói chuẩn. Không dùng \"talk English\". Irregular: speak-spoke-spoken.",
  "want to":"\"Want to\" = muốn. Trong văn nói nhanh thành \"wanna\". <i>I wanna go = I want to go</i>.",
  "I'd like to":"Lịch sự hơn \"I want to\". Dùng trong nhà hàng, cửa hàng: <i>I'd like to order...</i>",
};
async function askSentAI(uid, sentence, openBody) {
  if(openBody){
    const body=document.getElementById("body_"+uid);
    if(body&&!body.classList.contains("open")) toggleCard(uid);
  }
  const box=document.getElementById("aiSent_"+uid);
  if(!box)return;
  if(box.style.display==="block"){box.style.display="none";return;}
  if(box.dataset.cached==="1"){box.style.display="block";return;}
  const used2=getAIUsed();
  if(used2>=AI_LIMIT){
    box.style.display="block";
    box.innerHTML=`<span style='color:#dc3545;font-size:12px'>⚠ Đã dùng hết ${AI_LIMIT} lần hỏi AI hôm nay.</span>`;
    return;
  }
  box.style.display="block";
  box.innerHTML="<span style='color:#5dade2;font-style:italic'>⏳ Đang phân tích câu...</span>";
  let tip = AI_SENT_TIPS[sentence] || null;
  if(!tip) {
    try {
      tip = await callWorker("sentence_tip", { sentence });
    } catch(e){}
  }
  if(!tip) tip=`Câu này dùng cấu trúc tiếng Anh phổ biến ở trình độ B1-B2. Không thể lấy giải thích lúc này, thử lại sau.`;
  const closeBtn=`<button onclick="document.getElementById('aiSent_${uid}').style.display='none'" style="float:right;background:none;border:none;cursor:pointer;color:#aaa;font-size:14px;padding:0">✕</button>`;
  box.innerHTML=`${closeBtn}<span style='font-size:11px;color:#aaa'>Còn ${AI_LIMIT-used2-1} lần</span><br>${tip}`;
  box.dataset.cached="1";
  incAIUsed();
}
const AI_LIMIT = 300;
function getAIUsed(){ return parseInt(localStorage.getItem("ai_used_en8")||"0"); }
function incAIUsed(){ localStorage.setItem("ai_used_en8", getAIUsed()+1); updateAIBadge(); }
function updateAIBadge(){
  const used=getAIUsed();
  const rem=Math.max(0,AI_LIMIT-used);
  document.querySelectorAll(".word-ask-btn-inline").forEach(b=>{
    b.title=rem>0?`Hỏi AI (còn ${rem} lần)`:"Hết lượt hỏi AI hôm nay";
    b.style.opacity=rem>0?"1":"0.4";
  });
}
async function askWordAI(wid, word, sentence) {
  const box=document.getElementById("wai_"+wid);
  if(!box)return;
  if(box.style.display==="block"){box.style.display="none";return;}
  if(box.dataset.cached==="1"){box.style.display="block";return;}
  const used=getAIUsed();
  if(used>=AI_LIMIT){
    box.style.display="block";
    box.innerHTML=`<span style='color:#dc3545;font-size:12px'>⚠ Đã dùng hết ${AI_LIMIT} lần hỏi AI. Nâng cấp để dùng thêm.</span>`;
    return;
  }
  box.style.display="block";
  box.innerHTML="<span style='color:#5dade2;font-style:italic'>⏳ Đang hỏi AI...</span>";
  let tip = AI_WORD_TIPS[word] || null;
  if(!tip) {
    try {
      tip = await callWorker("word_explain", { word, sentence });
    } catch(e){}
  }
  if(!tip) tip=`Từ "<b>${word}</b>" trong câu này. Không thể lấy giải thích lúc này, thử lại sau.`;
  box.innerHTML=`<div style="font-size:12px;line-height:1.8;color:#333;border-left:3px solid #5dade2;padding-left:8px">${(tip||"").replace(/\n/g,"<br>")}</div><div style="text-align:right;font-size:10px;color:#aaa;margin-top:4px">Còn ${AI_LIMIT-used-1} lần</div>`;
  box.dataset.cached="1";
  incAIUsed();
}
const MOCK_A12={"I am":{"sentence":"Tôi là","chunks":[],"words":{"I":{"meaning":"Tôi","level":"A1-A2","type":"pronoun","grammar":null,"example":"I am a student."}}}};
const MOCK_B12={};
function getMock(sentence,level){
  const db=(level==="A1-A2"||level==="B1")?MOCK_A12:MOCK_B12;
  if(db[sentence])return db[sentence];
  const words=sentence.replace(/[.,!?'"]/g,"").split(/\s+/).filter(w=>w.length>2);
  const obj={};
  if(level==="B2"){
    words.slice(0,5).forEach(w=>{obj[w]={phrase:w,meaning:"(demo)",level:"B1",type:"word",role:"",grammar:null};});
  } else {
    words.slice(0,4).forEach(w=>{obj[w]={meaning:"(demo)",level:"A1-A2",type:"noun"};});
  }
  return{sentence:"(Bản dịch demo)",words:obj};
}
// ── AI call (real) ────────────────────────────────────────────
async function callAI(sentence, level) {
  const content = await callWorker("analyze_sentence", { sentence, level });
  if (!content) {
    // Bị chặn có lý do (hết credit tầng Student) -> báo rõ cho Student, không dùng demo
    if (lastBlockMessage) throw new Error(lastBlockMessage);
    // Lỗi mạng thật -> dùng dữ liệu demo để UI không bị treo
    return getMock(sentence, level);
  }
  try { return JSON.parse(content); }
  catch {
    const m2 = content.match(/\{[\s\S]*/);
    if (m2) { try { return JSON.parse(m2[0]); } catch {} }
    return { sentence: "⚠ JSON lỗi", words: {} };
  }
}
// ── Prompts ───────────────────────────────────────────────────
// buildPrompt() đã chuyển toàn bộ sang Worker (xem prompts.js) — không còn ở đây nữa.
// ── Test system ──────────────────────────────────────────────
async function analyze(){
  const text=txt.value.trim();
  if(!text)return;
  currentRunId++;
  const runId=currentRunId;
  out.innerHTML="";lastAnalyzedData=[];
  document.getElementById("audioBar").classList.remove("show");
  saveHistory(text,"");
  // ── Sentence splitting with subindex tracking ────────────────
  const MAX_WORDS = currentLevel==="B2" ? 20 : 28;
  const lines=(()=>{
    const paras=text.replace(/\r\n/g,"\n").split(/\n+/).map(x=>x.trim()).filter(Boolean);
    const entries=[];
    let paraNum=0;
    for(const para of paras){
      paraNum++;
      if(/^[A-Z][a-zA-Z]*:\s/.test(para)){
        entries.push({text:para,speaker:null,parentIdx:paraNum,subIdx:0});
        continue;
      }
      // Protect abbreviations
      let s=para
        .replace(/\b(Mr|Mrs|Ms|Dr|Prof|St|vs|etc|e\.g|i\.e|Jr|Sr|No|Fig|U\.S|U\.K|U\.N|U\.A\.E|D\.C|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.(?=\s|$)/gi,"$1\x01")
        .replace(/\b([A-Z])\.([A-Z])\./g,"$1\x03$2\x03")
        .replace(/\b([A-Z])\./g,"$1\x04")
        .replace(/(\d)\.(\d)/g,"$1\x02$2")
        .replace(/\.\.\./g,"\x05");
      // Split ONLY at sentence boundaries (period/!/? followed by capital letter)
      const parts = s.split(/(?<=[.!?])\s+(?=[A-Z"\u2018\u201C$\(])/)
        .map(p=>p.replace(/\x01/g,".").replace(/\x02/g,".").replace(/\x03/g,".").replace(/\x04/g,".").replace(/\x05/g,"...").trim())
        .filter(Boolean);
      // Split long sentences at natural break points (comma near middle)
      const splitLong = (sent) => {
        const words = sent.split(/\s+/);
        if (words.length <= MAX_WORDS) return [sent];
        const mid = Math.floor(words.length / 2);
        // Only split at comma/semicolon/colon — NOT at random word boundary
        const tokens = sent.split(/(,\s|;\s|:\s)/);
        if (tokens.length > 2) {
          let best = -1, bestDist = Infinity, cumWords = 0;
          for (let i = 0; i < tokens.length; i += 2) {
            cumWords += tokens[i].split(/\s+/).length;
            const dist = Math.abs(cumWords - mid);
            if (dist < bestDist && cumWords >= 6 && i+1 < tokens.length) {
              bestDist = dist; best = i;
            }
          }
          if (best >= 0) {
            const a = tokens.slice(0, best+2).join("").trim();
            const b = tokens.slice(best+2).join("").trim();
            if (a && b && b.split(/\s+/).length >= 4) return [a, b];
          }
        }
        return [sent]; // Don't split if no good split point
      };
      // Merge short fragments, then split long ones
      const merged=[];
      let buf="";
      for(const p of parts){
        const wc=p.split(/\s+/).filter(Boolean).length;
        if(buf){
          buf=buf+" "+p;
          if(/[.!?]$/.test(p)||buf.split(/\s+/).length>=5){
            splitLong(buf).forEach(x=>merged.push(x));buf="";
          }
        } else if(wc<4&&!/[.!?]$/.test(p)){
          buf=p;
        } else {
          splitLong(p).forEach(x=>merged.push(x));
        }
      }
      if(buf) splitLong(buf).forEach(x=>merged.push(x));
      const subLabels=["a","b","c","d","e","f"];
      if(merged.length===1){
        entries.push({text:merged[0],speaker:null,parentIdx:paraNum,subIdx:0});
      } else {
        merged.forEach((m,mi)=>{
          entries.push({text:m,speaker:null,parentIdx:paraNum,subIdx:mi+1,subLabel:subLabels[mi]||String(mi+1)});
        });
      }
    }
    const seen=new Set();
    return entries.filter(e=>{if(seen.has(e.text))return false;seen.add(e.text);return true;});
  })();
  setStatus(`⏳ Đang phân tích... (0/${lines.length})`);
  let completed=0;
  let firstCard=true;
  for(let si=0;si<lines.length;si++){
    const entry=lines[si];
    const rawText=entry.text;
    const m=rawText.match(/^([A-Z][a-zA-Z]*):\s+(.+)$/s);
    const speaker=m?m[1]:(entry.speaker||null);
    const content=m?m[2].trim():rawText;
    const parentNum=entry.parentIdx;
    const subLabel=entry.subLabel||null;
    // Display number: "3" or "3a", "3b"
    const displayNum=subLabel?`${parentNum}${subLabel}`:String(parentNum);
    const uid="s"+si;
    const sentKey = "s_" + content.trim().slice(0,40).replace(/[^a-zA-Z0-9]/g,"_");
    const card=document.createElement("div");
    card.className="sent-card";card.id="card_"+uid;
    const s=getStats();
    const isSavedSent=(s.savedSentList||[]).some(x=>x.key===sentKey);
    card.setAttribute("data-sentence", content);
    card.setAttribute("data-si", si);
    card.setAttribute("data-sentkey", sentKey);
    card.setAttribute("data-uid", uid);
    const isB12 = currentLevel === "B2";
    const isA2  = currentLevel === "B1";
    const sentNum = displayNum;
    card.innerHTML= isB12
      ? `<div class="sent-header" style="align-items:center;padding:8px 14px 6px;border-left:4px solid #5dade2">
${speaker
? `<span style="font-size:12px;color:#aed6f1;margin-right:4px">#${sentNum}</span><span class="sent-speaker">${speaker}</span>`
: `<span style="font-size:12px;color:#888;margin-right:4px">#${sentNum}</span>`}
<div style="flex:1;min-width:0"></div>
<div style="display:flex;gap:2px;flex-shrink:0;align-items:center">
<button class="sent-star ${isSavedSent?"saved":""}" onclick="event.stopPropagation();sentStarClick(this)" title="Lưu câu">${isSavedSent?"🌟":"☆"}</button>
<button class="sent-ask" style="font-size:15px" onclick="event.stopPropagation();b12TogglePlainBtn(this,'${uid}')" title="Plain Text">📄</button>
<button class="sent-ask" onclick="event.stopPropagation();sentTextClick(this)" title="Nghe câu">🔊</button>
<button class="sent-ask" onclick="event.stopPropagation();sentAskClick(this,'${uid}')" title="Hỏi AI">💬</button>
</div>
</div>
<div class="sent-body open" id="body_${uid}">
<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>
</div>`
      : `<div class="sent-header">
<span class="sent-toggle" id="arrow_${uid}" onclick="toggleCard('${uid}')">▶</span>
${speaker?`<span class="sent-speaker">${speaker}:</span>`:""}
<span class="sent-text" onclick="sentTextClick(this)" style="cursor:pointer">${content}</span>
<button class="sent-star ${isSavedSent?"saved":""}" onclick="event.stopPropagation();sentStarClick(this)" title="Lưu câu">${isSavedSent?"🌟":"☆"}</button>
<button class="sent-ask" onclick="event.stopPropagation();sentAskClick(this,'${uid}')" title="Hỏi AI">💬</button>
</div>
<div class="sent-body" id="body_${uid}">
<div class="skeleton"></div><div class="skeleton" style="width:70%"></div>
</div>`;
    out.appendChild(card);
    if(currentLevel==="A1" || currentLevel==="A1-A2" || currentLevel==="B1"){
      if(firstCard){toggleCard(uid);firstCard=false;}
    }
    (async()=>{
      try{
        let data=await callAI(content,currentLevel);
        if(runId!==currentRunId)return;
        // ── Post-process: fill missing meaning/example ──────────
        if(currentLevel==="A1-A2"&&data.words){
          const missing=Object.entries(data.words).filter(([,v])=>
            !v.meaning||v.meaning==="null"||v.meaning.trim()===""||
            !v.example||v.example==="null"||v.example.trim()===""
          );
          if(missing.length>0){
            const fixPrompt=`For each English word/phrase below, provide BOTH fields in Vietnamese/English.
Sentence context: "${content}"
Words needing data: ${missing.map(([w])=>`"${w}"`).join(", ")}
Return ONLY JSON: {${missing.map(([w])=>`"${w}":{"meaning":"1-5 word Vietnamese meaning","example":"Short English example sentence"}`).join(",")}}
RULES: meaning in Vietnamese (1-5 words, never empty). example in English only (never empty).`;
            try{
              const patch=await callAI(fixPrompt);
              if(patch&&typeof patch==="object"){
                missing.forEach(([w])=>{
                  if(patch[w]){
                    if(!data.words[w].meaning||data.words[w].meaning==="null")
                      data.words[w].meaning=patch[w].meaning||data.words[w].meaning;
                    if(!data.words[w].example||data.words[w].example==="null")
                      data.words[w].example=patch[w].example||data.words[w].example;
                  }
                });
              }
            }catch(_){}
          }
        }
        // ── TẦNG 2+3: Post-process + Validate B1/B2 data ──────────────
        if((currentLevel==="B2"||currentLevel==="B1")){
          if(data.words) {
            data.words = postProcessB12Words(data.words);
            data.words = validateAndAutoFix(data.words, content);
          }
          // B1 mode: fix data.chunks + merge token_meanings vào data.words
          if(data.chunks && Array.isArray(data.chunks)) {
            data.chunks = postProcessChunks(data.chunks, content);
            // Merge: bổ sung meaning còn thiếu trong data.words từ chunk token_meanings
            data.words = mergeChunkTokenMeanings(data.chunks, data.words || {});
          }
        }
        lastAnalyzedData[si]={sentence:content,data,speaker};
        const body=document.getElementById("body_"+uid);
        if(body)body.innerHTML=
          currentLevel==="B2" ? buildB12Html(content,data,uid,si) :
          currentLevel==="B1"    ? buildA2Html(content,data,uid,si) :
                                   currentLevel==="A1" ? buildA1Html(content,data,uid,si) : buildA12Html(content,data,uid,si);
      }catch(e){
        const body=document.getElementById("body_"+uid);
        const msg=e?.message||e?.msg||String(e)||"";
        const isCors=msg.includes("fetch")||msg.includes("Failed")||msg.includes("NetworkError")||msg.includes("CORS");
        if(body)body.innerHTML=`<div style="color:#dc3545;font-size:12px;padding:4px 0">
          ❌ ${isCors?"Lỗi kết nối API — Hãy mở file trên server (không mở trực tiếp file://)":"Lỗi xử lý: "+msg.slice(0,80)}
        </div>`;
      }finally{
        completed++;
        if(runId===currentRunId){
          setStatus(`⏳ (${completed}/${lines.length})`);
          if(completed===lines.length){
            setStatus(`✅ Hoàn tất — ${lines.length} câu`);
            document.getElementById("audioBar").classList.add("show");
            document.getElementById("abTime").textContent=`0 / ${lines.length} câu`;
            saveHistory(text,out.innerHTML);
            const st=getStats();updateStreak(st);
            st.credits=Math.max(0,(st.credits||0)-1);
            saveStats(st);renderStats();updateBadges();updateAIBadge();loadLibrarySidebar();
          }
        }
      }
    })();
  }
}
// ── Init ──────────────────────────────────────────────────────
renderStats();updateBadges();updateAIBadge();

// ===== EXAM OVERLAY SCRIPT =====

let _exam={data:null,answers:{},submitted:false,timer:null,timeLeft:0,currentPart:0,woState:{},attemptNumber:1,timeCapPct:100,startedAt:0};
function examOpen(examId,opts){
  const row=mentorExams.find(e=>e.id===examId) || (typeof studentExamItems!=="undefined" ? studentExamItems.find(e=>e.id===examId) : null);
  if(!row){alert("Không tìm thấy đề thi.");return;}
  _exam.data={
    id: row.id, title: row.title, examType: row.exam_type, level: row.level,
    duration: row.duration_minutes, questions: row.questions_count,
    parts: row.payload?.parts||[], created: new Date(row.created_at).getTime(),
  };
  _exam.answers={};_exam.submitted=false;_exam.currentPart=0;_exam.woState={};
  _exam.attemptNumber=opts?.attemptNumber||1;
  _exam.timeCapPct=opts?.timeCapPct||100;
  _exam.startedAt=Date.now();
  clearInterval(_exam.timer);
  const d=_exam.data;
  document.getElementById("examHdTitle").textContent=(d.examType==="ptth"?"🏫 PTTH":d.examType==="vocab"?"📝 Bài kiểm tra":"🎓 IELTS")+" — "+d.title;
  const totalQ=d.parts.reduce((a,p)=>a+(p.sections||[]).reduce((b,s)=>b+(s.questions?.length||0),0),0);
  document.getElementById("examHdSub").textContent=`Level ${d.level} · ${totalQ} câu · ${d.duration} phút`;
  document.getElementById("examOverlay").style.display="flex";
  document.body.style.overflow="hidden";
  examBuildTabs();
  examShowPart(0);
  const cappedDuration=Math.max(1,Math.round((d.duration||60)*_exam.timeCapPct/100));
  examStartTimer(cappedDuration);
}
function examClose(){
  clearInterval(_exam.timer);
  document.getElementById("examOverlay").style.display="none";
  document.body.style.overflow="";
}
function examStartTimer(min){
  _exam.timeLeft=min*60;
  examUpdateTimer();
  _exam.timer=setInterval(()=>{
    _exam.timeLeft--;
    examUpdateTimer();
    if(_exam.timeLeft<=0){clearInterval(_exam.timer);examSubmit(true);}
  },1000);
}
function examUpdateTimer(){
  const m=Math.floor(_exam.timeLeft/60),s=_exam.timeLeft%60;
  const el=document.getElementById("examTimer");
  el.textContent=String(m).padStart(2,"0")+":"+String(s).padStart(2,"0");
  el.style.background=_exam.timeLeft<300?"rgba(230,126,34,.8)":_exam.timeLeft<60?"rgba(192,57,43,.9)":"rgba(255,255,255,.15)";
  if(_exam.timeLeft<60)el.style.animation="pulse .5s infinite";
  else el.style.animation="";
}
function examBuildTabs(){
  const ICONS=["📖","🎧","📝","✍️"];
  document.getElementById("examPartTabs").innerHTML=_exam.data.parts.map((p,i)=>`
    <button class="ptab${i===0?" act":""}" id="ptab_${i}" onclick="examShowPart(${i})">
      ${ICONS[i]||"📋"} ${p.name||"Part "+(i+1)}
      <small id="ptchk_${i}"></small>
    </button>`).join("");
}
function examShowPart(idx){
  _exam.currentPart=idx;
  document.querySelectorAll(".ptab").forEach((t,i)=>t.classList.toggle("act",i===idx));
  const part=_exam.data.parts[idx];
  document.getElementById("examContent").innerHTML=part?examRenderPart(part,idx):`<div style="padding:40px;text-align:center;color:#aaa">Phần này đang cập nhật.</div>`;
}
function examRenderPart(part,pi){
  const isListenPart=(part.skill==="listening")||(part.name||"").toLowerCase().includes("listen")||
    (part.name||"").toLowerCase().includes("nghe");
  return (part.sections||[]).map((sec,si)=>{
    const qs=sec.questions||[];
    let body="";
    // Auto-detect shared audio: all listening Qs in section share same audio_text
    const audioTexts=[...new Set(qs.map(q=>(q.audio_text||"").trim()).filter(t=>t.length>10))];
    const isSharedAudio=isListenPart&&audioTexts.length===1&&qs.length>1;
    const sharedAudioSrc=sec.audio_text||sec.shared_audio||(isSharedAudio?audioTexts[0]:null);
    if(sharedAudioSrc){
      const sa=sharedAudioSrc.replace(/'/g,"\\'").replace(/"/g,"&quot;");
      body+=`<div style="background:#1a3c6e;border-radius:8px;padding:14px 18px;margin-bottom:16px">
        <div style="font-size:11px;color:#9dbee0;margin-bottom:8px;font-weight:700;letter-spacing:.5px">🎧 AUDIO — NGHE TRƯỚC KHI LÀM BÀI</div>
        <button class="elisten" id="shared_${pi}_${si}" onclick="examPlayShared('${sa}',this)" style="font-size:14px;padding:10px 20px;width:100%;justify-content:center">
          🔊 Phát audio
        </button>
        <div style="font-size:11px;color:#9dbee0;margin-top:8px;font-style:italic">Tất cả ${qs.length} câu hỏi bên dưới đều dựa trên audio này</div>
      </div>`;
    }
    if(sec.passage){
      body+=`<div class="epassage">${sec.passageTitle?`<div class="epassage-title">${sec.passageTitle}</div>`:""}${sec.passage}</div>`;
    }
    body+=qs.map((q,qi)=>examRenderQ(q,`${pi}_${si}_${qi}`,isListenPart,sharedAudioSrc,isSharedAudio)).join("");
    return `<div class="esec"><div class="esec-hd"><span>${sec.title||part.name}</span><span style="font-size:9px;color:#9dbee0">${qs.length} câu</span></div>
      <div class="esec-body">${sec.instruction?`<div class="einstr">${sec.instruction}</div>`:""}${body}</div></div>`;
  }).join("");
}
function examPlayShared(text,btn){
  speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(text);u.lang="en-US";u.rate=0.82;
  try{applyVolume(u);}catch(e){}
  if(btn){btn.textContent="▶ Đang phát...";btn.style.background="#e67e22";}
  u.onend=()=>{if(btn){btn.textContent="🔊 Nghe lại";btn.style.background="#2c5282";}};
  speechSynthesis.speak(u);
}
function examRenderQ(q,gid,isListenPart=false,sharedAudio=null,isSharedAudio=false){
  const L=["A","B","C","D"];
  const stripSRef=(s)=>(s||"").replace(/"\[S\d+\]"\s*/g,"").replace(/\[S\d+\]\s*/g,"").trim();
  const typeRaw=(q.type||"mcq").toLowerCase().replace(/-/g,"_");
  const typeMap={
    "multiple_choice":"mcq","vocabulary_mcq":"mcq","grammar_mcq":"mcq",
    "tense_form":"mcq","sentence_transform":"mcq","error_correction":"mcq",
    "word_family":"mcq","inference":"mcq","collocation":"mcq",
    "gap_fill":"gap_fill","fill_in_blank":"gap_fill","fill_blank":"gap_fill","gapfill":"gap_fill",
    "true_false_ng":"tfng","true_false_not_given":"tfng","tfng":"tfng","tf_ng":"tfng",
    "word_order":"word_order","word_ordering":"word_order","ordering":"word_order",
    "listening":"listening",
    "writing":"writing","writing_task":"writing","free_writing":"writing","open_ended":"writing"
  };
  // Smart type detection: override if AI returns inconsistent data
  let type=typeMap[typeRaw]||"mcq";
  const hasOptions=(q.options&&q.options.length>0);
  // If in listening section, force listening type (AI often forgets)
  if(isListenPart && type!=="tfng" && type!=="gap_fill" && type!=="writing") type="listening";
  // If correct="open" or no options → writing
  if(!hasOptions && q.correct==="open") type="writing";
  // If type=mcq but no options → writing
  if(type==="mcq" && !hasOptions && !q.question?.includes("[BLANK]")) type="writing";
  let qtext=stripSRef(q.question||"");
  const hasBlank=qtext.includes("[BLANK]");
  const correctAnswer=(q.correct_text||q.correct||"").replace(/'/g,"\\'");
  if(hasBlank){
    if(!hasOptions){
      // Pure gap-fill: render real input
      qtext=qtext.replace(/\[BLANK\]/g,
        `<input type="text" id="gap_${gid}" placeholder="   " autocomplete="off"
          style="border:none;border-bottom:2.5px solid #2c5282;background:transparent;
                 font-size:14px;width:120px;text-align:center;outline:none;
                 color:#2c5282;font-weight:700;padding:2px 6px;margin:0 3px"
          oninput="examGapInput('${gid}','${correctAnswer}')">`);
    } else {
      // Has options → show visual blank only, answer via buttons below
      qtext=qtext.replace(/\[BLANK\]/g,`<span style="display:inline-block;border-bottom:2px solid #2c5282;min-width:80px;margin:0 4px;color:#2c5282;font-weight:700">&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;</span>`);
    }
  }
  // Build options HTML (shared by mcq types)
  const buildOpts=(q2)=>{
    let opts=q2.options||[];
    const qtext2=q2.question||"";

    // Case 1: AI used (A)word (B)word format in question text
    if(!opts.length||opts.every(o=>/^[A-D]\.?\s*$/.test(o.trim()))){
      const inline=qtext2.match(/\(([A-D])\)([^()A-D][^()]*?)(?=\s*\([A-D]\)|$)/g);
      if(inline&&inline.length>=2){
        opts=inline.map((p,i)=>{
          const letter=(p.match(/\(([A-D])\)/)||[])[1]||L[i];
          const word=p.replace(/\([A-D]\)/,"").trim().replace(/[,;]$/,"").trim();
          return `${letter}. ${word}`;
        });
      }
    }

    // Case 2: AI used [A]word [B]word format in question text
    if(!opts.length||opts.every(o=>/^[A-D]\.?\s*$/.test(o.trim()))){
      const bracketed=qtext2.match(/\[([A-D])\]([^\[]+)/g);
      if(bracketed&&bracketed.length>=2){
        opts=bracketed.map((p,i)=>{
          const letter=(p.match(/\[([A-D])\]/)||[])[1]||L[i];
          const word=p.replace(/\[[A-D]\]/,"").trim().replace(/[,;]$/,"").trim();
          return `${letter}. ${word}`;
        });
      }
    }

    if(!opts.length) return `<div style="color:#e67e22;font-size:12px;padding:4px 0 4px 30px">⚠ Không có đáp án — dữ liệu đề bị lỗi</div>`;
    return `<div class="eopts" id="eopts_${gid}">${opts.map((o,oi)=>{
      const letter=o.match(/^[A-D]\s*[.\)]/i)?o[0].toUpperCase():L[oi];
      const text=o.replace(/^[A-D]\s*[.\)]\s*/i,"").trim();
      if(!text) return ""; // skip empty-text options
      const isCorrect=letter===q2.correct||(q2.correct_text&&q2.correct_text.toLowerCase()===text.toLowerCase());
      return `<button class="eopt" onclick="examPick('${gid}',this,'${letter}','${q2.correct}')"
        data-val="${letter}" data-correct="${isCorrect}">
        <span class="eletter">${letter}</span>${text}</button>`;
    }).filter(Boolean).join("")}</div>`;
  };
  let inner="";
  let passRef=stripSRef(q.passage_ref||"");
  // Don't show passage_ref if it's an S-ref or same as question
  if(passRef&&(passRef.includes("[S")||passRef===stripSRef(q.question||"")))passRef="";
  if(type==="word_order"){
    const src=(q.correct||q.words_to_order||q.question||"").replace(/[.!?;]$/,"").trim();
    const words=src.split(/\s+/).filter(Boolean);
    // Fallback to MCQ if too short
    if(words.length<4){
      inner=`${passRef?`<div class="eq-ref">"${passRef}"</div>`:""}${buildOpts(q)}`;
    } else {
      const shuffled=[...words].sort(()=>Math.random()-.5);
      _exam.woState[gid]={correct:src,current:[],words:shuffled};
      inner=`<div class="wo-drop" id="wod_${gid}" onclick="examWoClear('${gid}')" title="Nhấn để xóa">
      <span id="woph_${gid}" style="color:#aaa;font-size:11px;font-style:italic">
        Nhấn từng từ bên dưới để sắp xếp thành câu đúng &nbsp;·&nbsp; nhấn ô này để xóa
      </span></div>
      <div class="wo-pool" id="wop_${gid}">
        ${shuffled.map((w,i)=>`<button class="wo-btn" id="wob_${gid}_${i}"
          onclick="examWoAdd('${gid}',this,'${w.replace(/'/g,"\\'")}')">${w}</button>`).join("")}
      </div>`;
    }
  } else if(type==="writing"||q.correct==="open"){
    inner=`${passRef?`<div class="eq-ref">"${passRef}"</div>`:""}
      <div style="margin-left:30px;margin-top:6px">
        <div style="font-size:12px;color:#888;margin-bottom:6px;font-style:italic">✍️ Write your answer in English:</div>
        <textarea id="write_${gid}" rows="3" placeholder="Enter your answer here..." style="width:100%;border:2px solid #2c5282;border-radius:6px;padding:10px;font-size:13px;font-family:inherit;resize:vertical;outline:none;background:#f8fbff;line-height:1.6" oninput="examWriteInput('${gid}')"></textarea>
      </div>`;
  } else if(type==="gap_fill"||hasBlank){
    inner=`${passRef?`<div class="eq-ref">"${passRef}"</div>`:""}`;
    if(q.options&&q.options.length){
      inner+=buildOpts(q);
    } else if(!hasBlank){
      // AI forgot [BLANK] — add a free-text input below the question
      inner+=`<div style="margin-left:30px;margin-top:6px">
        <input type="text" id="gap_${gid}" placeholder="Type your answer..." autocomplete="off"
          style="border:none;border-bottom:2.5px solid #2c5282;background:transparent;font-size:14px;width:200px;outline:none;color:#2c5282;font-weight:700;padding:2px 6px"
          oninput="examGapInput('${gid}','${(q.correct_text||q.correct||"").replace(/'/g,"\\'")}')">
      </div>`;
    }
    // else: free-text input already embedded in qtext via [BLANK]
  } else if(type==="tfng"){
    inner=`${passRef?`<div class="eq-ref">"${passRef}"</div>`:""}
      <div class="etfng" id="eopts_${gid}">
        ${["True","False","Not Given"].map(v=>`<button class="etfbtn"
          onclick="examPick('${gid}',this,'${v}','${q.correct}')"
          data-val="${v}" data-correct="${v===q.correct}">${v}</button>`).join("")}
      </div>`;
  } else if(type==="listening"){
    // Audio priority: per-question audio_text → passage_ref (if real sentence) → shared audio → question text
    const rawAudio=q.audio_text||(q.passage_ref&&q.passage_ref.length>8&&!q.passage_ref.includes("[S")?q.passage_ref:null)||(sharedAudio?null:q.question)||"";
    const atxt=(rawAudio||q.question||"").replace(/'/g,"\\'").replace(/"/g,"&quot;");
    const hasShared=!!sharedAudio;
    // Don't show per-question audio button if using shared audio (already shown above)
    const audioBtn=hasShared?`<div style="font-size:11px;color:#888;margin-bottom:8px;font-style:italic">⬆ Nghe audio chung bên trên để trả lời câu này</div>`:
      `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <button class="elisten" id="elb_${gid}" onclick="examListen('${gid}','${atxt}')">🔊 Play audio</button>
        <button onclick="examListen('${gid}','${atxt}')" style="background:none;border:none;cursor:pointer;color:#888;font-size:12px;padding:0">↺ Again</button>
      </div>`;
    // Options: T/F/NG or 4-choice
    const optHtml=(q.correct==="True"||q.correct==="False"||q.correct==="Not Given"||q.type==="tfng")?
      `<div class="etfng" id="eopts_${gid}">${["True","False","Not Given"].map(v=>`<button class="etfbtn" onclick="examPick('${gid}',this,'${v}','${q.correct}')" data-val="${v}" data-correct="${v===q.correct}">${v}</button>`).join("")}</div>`:
      buildOpts(q);
    inner=`${audioBtn}${optHtml}`;
  } else {
    // Default: MCQ (covers tense_form, error_correction, word_family, inference, sentence_transform...)
    inner=`${passRef?`<div class="eq-ref">"${passRef}"</div>`:""}${buildOpts(q)}`;
  }
  return `<div class="eq" id="eq_${gid}">
    <div class="eq-row">
      <span class="eq-num">${q.num||""}</span>
      <span class="eq-text">${qtext}</span>
    </div>
    ${inner}
    <div class="eexpl" id="eexpl_${gid}">
      ${type==="listening"&&q.audio_text
        ?`<div style="font-size:11px;color:#2c5282;margin-bottom:5px;padding:4px 8px;background:#f0f8ff;border-radius:4px">
            📄 <b>Transcript:</b> <i>"${q.audio_text}"</i>
           </div>`:""}
      ${q.explanation||""}
    </div>
  </div>`;
}
function examGapInput(gid,correct){
  const inp=document.getElementById("gap_"+gid);
  if(!inp)return;
  const val=inp.value.trim();
  _exam.answers[gid]={val,correct,answered:val.length>0,isGap:true};
  examUpdateProgress();examUpdatePartCheck();
}
function examWriteInput(gid){
  const ta=document.getElementById("write_"+gid);if(!ta)return;
  _exam.answers[gid]={val:ta.value.trim(),correct:"open",answered:ta.value.trim().length>0,isWrite:true};
  examUpdateProgress();examUpdatePartCheck();
}
function examPick(gid,btn,val,correct){
  if(_exam.submitted)return;
  document.querySelectorAll(`#eopts_${gid} .eopt,#eopts_${gid} .etfbtn`).forEach(b=>b.classList.remove("sel"));
  btn.classList.add("sel");
  _exam.answers[gid]={val,correct,answered:true};
  examUpdateProgress();examUpdatePartCheck();
}
function examListen(gid,text){
  const btn=document.getElementById("elb_"+gid);
  speechSynthesis.cancel();
  const u=new SpeechSynthesisUtterance(text);u.lang="en-US";u.rate=0.82;
  applyVolume(u);
  if(btn)btn.textContent="🔊 Playing...";
  u.onend=()=>{if(btn)btn.textContent="🔊 Play again";};
  speechSynthesis.speak(u);
}
function examWoAdd(gid,btn,word){
  if(_exam.submitted||btn.disabled)return;
  const st=_exam.woState[gid];if(!st)return;
  st.current.push(word);btn.disabled=true;
  const drop=document.getElementById("wod_"+gid);
  const ph=document.getElementById("woph_"+gid);
  if(ph)ph.style.display="none";
  if(drop){const sp=document.createElement("span");sp.className="wo-tag";sp.textContent=word;drop.appendChild(sp);}
  _exam.answers[gid]={val:st.current.join(" "),correct:st.correct,answered:true};
  examUpdateProgress();
}
function examWoClear(gid){
  if(_exam.submitted)return;
  const st=_exam.woState[gid];if(!st)return;
  st.current=[];delete _exam.answers[gid];
  const drop=document.getElementById("wod_"+gid);
  const ph=document.getElementById("woph_"+gid);
  if(drop)Array.from(drop.querySelectorAll(".wo-tag")).forEach(x=>x.remove());
  if(ph)ph.style.display="";
  document.querySelectorAll(`[id^="wob_${gid}_"]`).forEach(b=>b.disabled=false);
  examUpdateProgress();
}
function examUpdateProgress(){
  const total=_exam.data.parts.reduce((a,p)=>a+(p.sections||[]).reduce((b,s)=>b+(s.questions?.length||0),0),0);
  const done=Object.values(_exam.answers).filter(a=>a.answered).length;
  const pct=total?Math.round(done/total*100):0;
  document.getElementById("examProgress").style.width=pct+"%";
}
function examUpdatePartCheck(){
  _exam.data.parts.forEach((p,pi)=>{
    let tot=0,done=0;
    (p.sections||[]).forEach((s,si)=>{
      (s.questions||[]).forEach((_,qi)=>{if(_exam.answers[`${pi}_${si}_${qi}`]?.answered){done++;}tot++;});
    });
    const el=document.getElementById("ptchk_"+pi);
    if(el)el.textContent=done?`${done}/${tot}`:"";
  });
}
function examSubmit(timeUp=false){
  if(_exam.submitted)return;
  _exam.submitted=true;clearInterval(_exam.timer);
  let totalQ=0,totalOk=0;
  const breakdown=[];
  _exam.data.parts.forEach((part,pi)=>{
    let pOk=0,pTot=0;
    (part.sections||[]).forEach((sec,si)=>{
      (sec.questions||[]).forEach((q,qi)=>{
        const gid=`${pi}_${si}_${qi}`;
        const ans=_exam.answers[gid];
        const opts=document.querySelectorAll(`#eopts_${gid} .eopt,#eopts_${gid} .etfbtn`);
        opts.forEach(o=>{
          o.disabled=true;
          if(o.dataset.correct==="true")o.classList.add("reveal");
          if(o.classList.contains("sel")){o.classList.add(o.dataset.correct==="true"?"ok":"wrong");}
        });
        const typeRaw2=(q.type||"").toLowerCase().replace(/-/g,"_");
        const normType={"word_order":"word_order","word_ordering":"word_order","ordering":"word_order"}[typeRaw2]||typeRaw2;
        if(normType==="word_order"&&ans?.answered){
          const ok=ans.val.trim().toLowerCase()===ans.correct.trim().toLowerCase();
          const drop=document.getElementById("wod_"+gid);
          if(drop)drop.style.borderColor=ok?"#1e7e34":"#c0392b";
          if(ok)pOk++;
        } else if(ans?.isWrite){
          const ta=document.getElementById("write_"+gid);
          if(ta){ta.disabled=true;ta.style.borderColor="#1a3c6e";}
          const expl=document.getElementById("eexpl_"+gid);
          if(expl){
            expl.innerHTML=`<div style="margin-bottom:6px;padding:5px 8px;background:#eef2fa;border-radius:4px;font-size:12px"><b>Bài của bạn:</b> "${ans.val||"(chưa nhập)"}"</div>`+(q.explanation||"");
            expl.style.display="block";
          }
          if(ans.answered)pOk++;
        } else if(ans?.isGap){
          const inp=document.getElementById("gap_"+gid);
          const correct=(q.correct_text||q.correct||"").toLowerCase().trim();
          const val=(ans.val||"").toLowerCase().trim();
          const ok=val===correct||correct.includes(val)||val.includes(correct.split(" ")[0]);
          if(inp){inp.style.borderColor=ok?"#1e7e34":"#c0392b";inp.style.color=ok?"#155724":"#721c24";inp.disabled=true;}
          if(q.explanation){const expl=document.getElementById("eexpl_"+gid);if(expl)expl.style.display="block";}
          // Show correct answer
          if(!ok&&inp){const sp=document.createElement("span");sp.style.cssText="font-size:11px;color:#1e7e34;margin-left:8px;font-weight:600";sp.textContent="✓ "+correct;inp.after(sp);}
          if(ok)pOk++;
        } else if(ans?.answered){
          if(ans.val===q.correct||ans.correct===q.correct)pOk++;
        }
        const expl=document.getElementById("eexpl_"+gid);
        if(expl&&q.explanation)expl.style.display="block";
        pTot++;
      });
    });
    breakdown.push({name:part.name||"Part "+(pi+1),ok:pOk,tot:pTot});
    totalOk+=pOk;totalQ+=pTot;
  });
  const pct=totalQ?Math.round(totalOk/totalQ*100):0;
  const isIELTS=_exam.data.examType!=="ptth";
  const band=pct>=90?"8.5+":pct>=80?"7.5":pct>=70?"6.5":pct>=60?"5.5":pct>=50?"4.5":"<4.5";
  const ptth=Math.round(pct/10*2)/2;
  document.getElementById("examResultLabel").textContent=isIELTS?"IELTS BAND":"ĐIỂM PTTH";
  document.getElementById("examResultBand").textContent=isIELTS?band:ptth+"/10";
  document.getElementById("examResultScore").textContent=`${totalOk}/${totalQ} câu đúng (${pct}%)${timeUp?" — Hết giờ":""}`;
  document.getElementById("examResultBreakdown").innerHTML=breakdown.map(b=>`
    <div style="background:#f8f9fb;border-radius:5px;padding:8px 10px">
      <div style="font-weight:700;color:#1a3c6e;font-size:12px;margin-bottom:2px">${b.name}</div>
      <div style="font-size:12px;color:#555">${b.ok}/${b.tot} (${b.tot?Math.round(b.ok/b.tot*100):0}%)</div>
    </div>`).join("");
  document.getElementById("examResultModal").style.display="flex";
  // Lưu điểm: Mentor tự test đề của mình -> cập nhật last_score trên mentor_exams.
  // Student làm bài (xem task Student nộp bài) -> chèn thêm 1 dòng student_exam_submissions.
  try{
    const examId=_exam.data.id;
    if(currentMentor&&examId){
      supabase.from("mentor_exams").update({last_score:pct}).eq("id",examId).then(({error})=>{
        if(error)console.error("update last_score error:",error);
      });
      const item=mentorExams.find(e=>e.id===examId);
      if(item)item.last_score=pct;
    }
    if(typeof currentStudent!=="undefined"&&currentStudent&&examId){
      const timeSpentSeconds=Math.max(0,Math.round((Date.now()-(_exam.startedAt||Date.now()))/1000));
      supabase.from("student_exam_submissions").insert({
        exam_id:examId, student_id:currentStudent.id,
        answers:_exam.answers, score:pct, breakdown,
        time_spent_seconds:timeSpentSeconds,
      }).then(({error})=>{
        if(!error)return;
        console.error("insert submission error:",error);
        // 23505 = unique_violation (uq_exam_student_attempt) — 2 lần nộp gần như đồng
        // thời cùng tính trùng attempt_number, Postgres chỉ cho 1 request thắng.
        if(error.code==="23505")alert("Đang xử lý lượt nộp trước, vui lòng thử lại sau.");
        else if(error.message&&error.message.includes("Đã dùng hết 3 lượt"))alert("Đã dùng hết 3 lượt làm bài cho đề này.");
      });
    }
  }catch(e){}
}
function examShowAnswers(){
  _exam.submitted=true;clearInterval(_exam.timer);
  document.querySelectorAll(".eopt,.etfbtn").forEach(o=>{o.disabled=true;if(o.dataset.correct==="true")o.classList.add("reveal");});
  document.querySelectorAll(".eexpl").forEach(el=>el.style.display="block");
}
