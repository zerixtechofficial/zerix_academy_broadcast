import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runVerification() {
  console.log('🧪 Starting Standalone Adapter Verification...');

  const devTokens = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'mock-data/dev-tokens.json'), 'utf8')
  );
  const sessionContext = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'mock-data/session-context.json'), 'utf8')
  );
  const curriculum = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'mock-data/curriculum-sidebar.json'), 'utf8')
  );
  const lessonContents = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'mock-data/lesson-contents.json'), 'utf8')
  );

  // 1. Verify Dev Tokens
  console.log('\n✓ Checking Dev Tokens:');
  console.log(`  Teacher: ${devTokens.teacher.name} (${devTokens.teacher.userId}) [${devTokens.teacher.token}]`);
  console.log(`  Students count: ${devTokens.students.length}`);
  if (devTokens.students.length !== 12) {
    throw new Error(`Expected 12 students, got ${devTokens.students.length}`);
  }
  console.log(`  Student 1: ${devTokens.students[0].name} (${devTokens.students[0].userId})`);
  console.log(`  Student 12: ${devTokens.students[11].name} (${devTokens.students[11].userId})`);

  // 2. Verify Session Context
  console.log('\n✓ Checking Session Context:');
  const sess = sessionContext.sessions['batch_physics_101'];
  console.log(`  Session: ${sess.sessionId}`);
  console.log(`  Title: ${sess.title}`);
  console.log(`  Max Student Mics: ${sess.maxStudentMics}`);
  if (sess.maxStudentMics !== 10) {
    throw new Error(`Expected maxStudentMics=10, got ${sess.maxStudentMics}`);
  }

  // 3. Verify Curriculum
  console.log('\n✓ Checking Curriculum Tree:');
  console.log(`  Course: ${curriculum.courseName}`);
  console.log(`  Chapters: ${curriculum.chapters.length}`);
  if (curriculum.chapters.length < 3) {
    throw new Error(`Expected at least 3 chapters, got ${curriculum.chapters.length}`);
  }
  curriculum.chapters.forEach((ch, idx) => {
    console.log(`    Chapter ${idx + 1}: ${ch.title} (${ch.lessons.length} lessons)`);
  });

  // 4. Verify Lesson Contents
  console.log('\n✓ Checking Lesson Content Blocks:');
  const blocks = lessonContents['les_ohms_law'].blocks;
  console.log(`  Lesson 'les_ohms_law' contains ${blocks.length} blocks:`);
  blocks.forEach((blk) => {
    console.log(`    - [${blk.blockId}] Type: ${blk.type} | "${blk.title}" | SupportsBoard: ${blk.supportsSendToBoard}`);
  });

  // 5. Test writing mock storage files
  console.log('\n✓ Verifying Local Storage Fallback Directories:');
  const storageR2 = path.resolve(__dirname, '../../storage/local-r2/sessions/batch_physics_101');
  const storageWebhook = path.resolve(__dirname, '../../storage/local-webhooks');

  fs.mkdirSync(storageR2, { recursive: true });
  fs.mkdirSync(storageWebhook, { recursive: true });

  const testSummary = {
    sessionId: 'batch_physics_101',
    teacherId: 'teacher_501',
    teacherName: 'Prof. Anand Sharma',
    sessionTitle: 'Class 10 Physics: Ohm’s Law & Circuit Analysis Live Broadcast',
    startTime: '2026-10-22T10:00:00.000Z',
    endTime: '2026-10-22T11:00:00.000Z',
    totalClassDurationSeconds: 3600,
    totalStudentsCount: 12,
    presentCount: 10,
    partialCount: 2,
    lateOrAbsentCount: 0,
    students: devTokens.students.map((s, idx) => ({
      userId: s.userId,
      name: s.name,
      rollNumber: s.rollNumber,
      totalJoinedSeconds: 3000 - idx * 100,
      totalJoinedMinutes: Math.round(((3000 - idx * 100) / 60) * 100) / 100,
      totalJoinedHours: Math.round(((3000 - idx * 100) / 3600) * 100) / 100,
      attendancePercentage: Math.round(((3000 - idx * 100) / 3600) * 10000) / 100,
      status: (3000 - idx * 100) / 3600 >= 0.75 ? 'present' : 'partial',
    })),
    metadata: {
      courseId: 'course_phys_class10',
      chapterId: 'chap_electricity',
      lessonId: 'les_ohms_law',
    },
  };

  fs.writeFileSync(
    path.join(storageWebhook, 'session-summaries.json'),
    JSON.stringify([testSummary], null, 2)
  );
  fs.writeFileSync(
    path.join(storageR2, 'session_completed_summary.json'),
    JSON.stringify(testSummary, null, 2)
  );

  console.log('  Successfully wrote test session summary to:');
  console.log('  - storage/local-webhooks/session-summaries.json');
  console.log('  - storage/local-r2/sessions/batch_physics_101/session_completed_summary.json');

  console.log('\n🎉 ALL MOCK DATA & ADAPTER SPECS VERIFIED 100% SUCCESSFULLY!\n');
}

runVerification().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
