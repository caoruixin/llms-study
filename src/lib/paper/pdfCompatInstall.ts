/**
 * 副作用模块:import 即安装 pdf.js 的 WebKit 兼容 shim(见 pdfCompat.ts)。
 * 存在的意义是 ES module 的求值顺序保证——pdfWorkerEntry.ts 里它排在官方 worker
 * 脚本之前,静态 import 依声明顺序求值,shim 必然先于 worker 代码装好。
 */
import { ensurePdfCompat } from './pdfCompat'

ensurePdfCompat()
