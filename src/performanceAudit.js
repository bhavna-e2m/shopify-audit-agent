import lighthouse from 'lighthouse';
import * as puppeteer from 'puppeteer';

export async function runPerformanceAudit(url) {
  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const runnerResult = await lighthouse(url, {
      logLevel: 'error',
      output: 'json',
      onlyCategories: ['performance', 'accessibility', 'seo', 'best-practices'],
      port: new URL(browser.wsEndpoint()).port,
    });

    const report = runnerResult.lhr;
    const categories = report.categories;

    return {
      performance: {
        score: Math.round(categories.performance.score * 100),
        metrics: {
          firstContentfulPaint: report.audits['first-contentful-paint']?.displayValue,
          speedIndex: report.audits['speed-index']?.displayValue,
          largestContentfulPaint: report.audits['largest-contentful-paint']?.displayValue,
          cumulativeLayoutShift: report.audits['cumulative-layout-shift']?.displayValue,
          totalBlockingTime: report.audits['total-blocking-time']?.displayValue,
        } 
      },
      accessibility: {
        score: Math.round(categories.accessibility.score * 100),
      },
      seo: {
        score: Math.round(categories.seo.score * 100),
      },
      bestPractices: {
        score: Math.round(categories['best-practices'].score * 100),
      }
    };
  } catch (error) {
    console.error('Performance audit failed:', error.message);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}