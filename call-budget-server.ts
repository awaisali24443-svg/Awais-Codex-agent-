import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const BUDGET_FILE = path.join(DATA_DIR, 'call-budget.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function getTodayDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export interface CallBudgetRecord {
  date: string;
  whatsappCount: number;
  websiteCount: number;
  totalCount: number;
}

export function getServerCallBudget(): CallBudgetRecord {
  const today = getTodayDateString();
  try {
    ensureDataDir();
    if (fs.existsSync(BUDGET_FILE)) {
      const data = JSON.parse(fs.readFileSync(BUDGET_FILE, 'utf-8'));
      if (data && data.date === today) {
        const whatsappCount = Number(data.whatsappCount) || 0;
        const websiteCount = Number(data.websiteCount) || 0;
        return { date: today, whatsappCount, websiteCount, totalCount: whatsappCount + websiteCount };
      }
    }
  } catch (err) {
    console.error('[Call Budget] Error reading file:', err);
  }
  return { date: today, whatsappCount: 0, websiteCount: 0, totalCount: 0 };
}

export function incrementServerCallBudget(source: 'whatsapp' | 'website'): CallBudgetRecord {
  const today = getTodayDateString();
  const current = getServerCallBudget();
  if (source === 'whatsapp') {
    current.whatsappCount++;
  } else {
    current.websiteCount++;
  }
  current.totalCount = current.whatsappCount + current.websiteCount;
  try {
    ensureDataDir();
    fs.writeFileSync(BUDGET_FILE, JSON.stringify({
      date: today,
      whatsappCount: current.whatsappCount,
      websiteCount: current.websiteCount
    }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Call Budget] Error writing file:', err);
  }
  return current;
}
