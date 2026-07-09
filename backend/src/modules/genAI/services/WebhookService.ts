import { injectable } from 'inversify';
import axios, { AxiosInstance } from 'axios';
import { JobState } from '../classes/transformers/GenAI.js';
import { aiConfig } from '#root/config/ai.js';
import { appConfig } from '#root/config/index.js';
import http from 'http';
import https from 'https';

// ─────────────────────────────────────────────────────────────────────────────
// Mock AI pipeline simulator
//
// This class replaces real calls to the external AI server with an in-process
// simulation.  When the backend calls approveTaskStart / rerunTask it returns
// immediately (so the HTTP request doesn't time out), then fires a sequence of
// RUNNING → COMPLETED webhooks back to our own /api/genAI/webhook endpoint.
//
// The mock file-server on port 9090 serves stub transcript & question JSON that
// the uploadContent step will fetch via HTTP.  It starts lazily the first time
// a webhook is triggered and stays up for the lifetime of the process.
// ─────────────────────────────────────────────────────────────────────────────

// Fallback / default values
const DEFAULT_SEGMENT_MAP = [60, 120, 180, 240, 300];

const MOCK_TRANSCRIPT = {
  chunks: DEFAULT_SEGMENT_MAP.map((end, i) => ({
    text: `Segment ${i + 1}: content covering topic ${i + 1}.`,
    timestamp: [i === 0 ? 0 : DEFAULT_SEGMENT_MAP[i - 1], end],
  })),
};

const MOCK_QUESTIONS = DEFAULT_SEGMENT_MAP.flatMap((segEnd, i) => [
  {
    question: {
      text: `Question ${i * 2 + 1}: What is the key concept in segment ${i + 1}?`,
      type: 'SELECT_ONE_IN_LOT',
      isParameterized: false,
      parameters: [],
      hint: `Review the content around timestamp ${i === 0 ? 0 : DEFAULT_SEGMENT_MAP[i - 1]}s.`,
      timeLimitSeconds: 60,
      points: 5,
      bloomLevel: 'knowledge',
    },
    solution: {
      incorrectLotItems: [
        { text: 'An unrelated concept', explaination: 'Incorrect.' },
      ],
      correctLotItem: { text: `The key concept of segment ${i + 1}`, explaination: 'Correct.' },
    },
    segmentId: segEnd,
    questionType: 'SELECT_ONE_IN_LOT',
  },
  {
    question: {
      text: `Question ${i * 2 + 2}: How does segment ${i + 1} content relate to real-world usage?`,
      type: 'SELECT_ONE_IN_LOT',
      isParameterized: false,
      parameters: [],
      hint: 'Think about practical applications.',
      timeLimitSeconds: 60,
      points: 5,
      bloomLevel: 'understanding',
    },
    solution: {
      incorrectLotItems: [
        { text: 'It does not apply in practice', explaination: 'Incorrect.' },
      ],
      correctLotItem: { text: 'It directly supports real-world problem solving', explaination: 'Correct.' },
    },
    segmentId: segEnd,
    questionType: 'SELECT_ONE_IN_LOT',
  },
]);

const MOCK_PORT = 9090;
let mockServerStarted = false;

// Stores custom generated maps and files for active jobs
const jobDataStore = new Map<string, { segmentMap: number[], transcript: any, questions: any }>();

function ensureMockFileServer() {
  if (mockServerStarted) return;
  mockServerStarted = true;

  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const reqUrl = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const jobId = reqUrl.searchParams.get('jobId') || '';
    const jobData = jobDataStore.get(jobId);

    if (reqUrl.pathname === '/transcript.json') {
      const data = jobData ? jobData.transcript : MOCK_TRANSCRIPT;
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } else if (reqUrl.pathname === '/questions.json') {
      const data = jobData ? jobData.questions : MOCK_QUESTIONS;
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  server.listen(MOCK_PORT, () => {
    console.log(`[MOCK] File server listening on http://localhost:${MOCK_PORT}`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[MOCK] Port ${MOCK_PORT} already in use — reusing existing server.`);
    } else {
      console.error('[MOCK] File server error:', err.message);
    }
  });
}

@injectable()
export class WebhookService {
  private readonly httpClient: AxiosInstance;
  private readonly aiServerUrl: string;

  constructor() {
    this.aiServerUrl = 'http://' + aiConfig.serverIP + ':' + aiConfig.serverPort;

    this.httpClient = axios.create({
      baseURL: this.aiServerUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Start the mock file-server on construction (once).
    ensureMockFileServer();
  }

  async AIServerCheck(): Promise<number> {
    console.log('[MOCK] AIServerCheck → 200');
    return 200;
  }

  /**
   * Helper to retrieve YouTube video duration (with a safe fallback)
   */
  private async getYoutubeDuration(url?: string): Promise<number> {
    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
      // Default fallback for uploaded audio files or invalid urls
      return 1800; // 30 minutes
    }
    return new Promise((resolve) => {
      https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, (res) => {
        let html = '';
        res.on('data', d => html += d);
        res.on('end', () => {
          const m1 = html.match(/"approxDurationMs"\s*:\s*"(\d+)"/i);
          if (m1) {
            const ms = parseInt(m1[1], 10);
            if (ms > 0) {
              resolve(Math.floor(ms / 1000));
              return;
            }
          }
          resolve(1800);
        });
      }).on('error', () => {
        resolve(1800);
      });
    });
  }

  /**
   * Posts a sequence of RUNNING → COMPLETED webhooks back to our own endpoint
   * after short delays, simulating the real async AI server.
   */
  private simulateAIWebhook(jobId: string, task: string, jobState?: JobState): void {
    console.log(`[MOCK] Scheduling simulation for task: ${task} (job: ${jobId})`);

    const webhookUrl = `http://localhost:${appConfig.port ?? 3141}/api/genAI/webhook`;

    const send = async (data: Record<string, unknown>) => {
      try {
        await axios.post(webhookUrl, { task, jobId, data });
        console.log(`[MOCK] Webhook sent — task=${task} status=${data.status}`);
      } catch (err: any) {
        console.error(`[MOCK] Webhook error for ${task}:`, err.message);
      }
    };

    // RUNNING after 1 s
    setTimeout(() => {
      send({ status: 'RUNNING' }).then(() => {
        // COMPLETED after another 3 s
        setTimeout(async () => {
          const completedData: Record<string, unknown> = { status: 'COMPLETED' };

          // Fetch or resolve job details
          const details = jobDataStore.get(jobId);
          const segmentMap = details ? details.segmentMap : DEFAULT_SEGMENT_MAP;

          if (task === 'AUDIO_EXTRACTION') {
            completedData.fileName = `audio_${jobId}.wav`;
            completedData.fileUrl = `http://localhost:${MOCK_PORT}/audio.wav`;
          } else if (task === 'TRANSCRIPT_GENERATION') {
            completedData.fileName = `transcript_${jobId}.json`;
            completedData.fileUrl = `http://localhost:${MOCK_PORT}/transcript.json?jobId=${jobId}`;
          } else if (task === 'SEGMENTATION') {
            completedData.segmentationMap = segmentMap;
            completedData.transcriptFileUrl = `http://localhost:${MOCK_PORT}/transcript.json?jobId=${jobId}`;
          } else if (task === 'QUESTION_GENERATION') {
            completedData.fileName = `questions_${jobId}.json`;
            completedData.fileUrl = `http://localhost:${MOCK_PORT}/questions.json?jobId=${jobId}`;
            completedData.segmentMapUsed = segmentMap;
          }

          await send(completedData);
        }, 3000);
      });
    }, 1000);
  }

  private async prepareJobData(jobId: string, jobState: JobState) {
    if (jobDataStore.has(jobId)) return;

    console.log('[MOCK] Preparing dynamic job data based on video duration...');
    const durationSeconds = await this.getYoutubeDuration(jobState.url);
    console.log(`[MOCK] Video duration resolved: ${durationSeconds} seconds`);

    const count = 5;
    const segmentDuration = durationSeconds / count;
    const segmentMap: number[] = [];
    for (let i = 1; i <= count; i++) {
      segmentMap.push(Math.round(segmentDuration * i));
    }

    const transcript = {
      chunks: segmentMap.map((end, i) => ({
        text: `Segment ${i + 1}: content covering topic ${i + 1}.`,
        timestamp: [i === 0 ? 0 : segmentMap[i - 1], end],
      })),
    };

    const questions = segmentMap.flatMap((segEnd, i) => [
      {
        question: {
          text: `Question ${i * 2 + 1}: What is the key concept in segment ${i + 1}?`,
          type: 'SELECT_ONE_IN_LOT',
          isParameterized: false,
          parameters: [],
          hint: `Review the content around timestamp ${i === 0 ? 0 : segmentMap[i - 1]}s.`,
          timeLimitSeconds: 60,
          points: 5,
          bloomLevel: 'knowledge',
        },
        solution: {
          incorrectLotItems: [
            { text: 'An unrelated concept', explaination: 'Incorrect.' },
          ],
          correctLotItem: { text: `The key concept of segment ${i + 1}`, explaination: 'Correct.' },
        },
        segmentId: segEnd,
        questionType: 'SELECT_ONE_IN_LOT',
      },
      {
        question: {
          text: `Question ${i * 2 + 2}: How does segment ${i + 1} content relate to real-world usage?`,
          type: 'SELECT_ONE_IN_LOT',
          isParameterized: false,
          parameters: [],
          hint: 'Think about practical applications.',
          timeLimitSeconds: 60,
          points: 5,
          bloomLevel: 'understanding',
        },
        solution: {
          incorrectLotItems: [
            { text: 'It does not apply in practice', explaination: 'Incorrect.' },
          ],
          correctLotItem: { text: 'It directly supports real-world problem solving', explaination: 'Correct.' },
        },
        segmentId: segEnd,
        questionType: 'SELECT_ONE_IN_LOT',
      },
    ]);

    jobDataStore.set(jobId, { segmentMap, transcript, questions });
  }

  async approveTaskStart(jobId: string, jobState: JobState): Promise<any> {
    console.log('[MOCK] approveTaskStart — task:', jobState.currentTask);
    if (jobState.currentTask) {
      await this.prepareJobData(jobId, jobState);
      this.simulateAIWebhook(jobId, jobState.currentTask, jobState);
    }
    return { message: 'Success' };
  }

  async approveTaskContinue(jobId: string): Promise<any> {
    console.log('[MOCK] approveTaskContinue — no-op (next task started by approveTaskStart)');
    return { message: 'Success' };
  }

  async abortTask(jobId: string): Promise<any> {
    console.log('[MOCK] abortTask — job:', jobId);
    return { message: 'Success' };
  }

  async rerunTask(jobId: string, jobState: JobState): Promise<any> {
    console.log('[MOCK] rerunTask — task:', jobState.currentTask);
    if (jobState.currentTask) {
      await this.prepareJobData(jobId, jobState);
      this.simulateAIWebhook(jobId, jobState.currentTask, jobState);
    }
    return { message: 'Success' };
  }
}