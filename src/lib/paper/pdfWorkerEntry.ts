/**
 * pdf.js worker 的包装入口:先装 WebKit 兼容 shim,再评估官方 worker 脚本。
 *
 * 为什么需要:worker 里有 15 处 `Map.getOrInsertComputed`(字形编译缓存、字体缓存等
 * 渲染必经路径),WebKit 未实现该方法;worker 是 pdf.js 自己的脚本,主线程的 polyfill
 * 到不了那条线程,只能把 workerSrc 指到这个包装上。
 *
 * 顺序靠 ES module 语义保证:静态 import 按声明顺序求值,pdfCompatInstall 的模块体
 * (安装 shim)先于 pdf.worker 的模块体执行;消息处理更是之后的事件循环任务,不存在竞态。
 *
 * 引用方式(PdfViewer / parsePdf):
 *   import workerUrl from '../../lib/paper/pdfWorkerEntry?worker&url'
 *   pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
 * dev 下 Vite 按模块直出,build 下打成独立 worker chunk(仍在 paper 子树内,
 * flag-off 构建随虚模块化一并摘除,产物零泄漏)。
 */
import './pdfCompatInstall'
import 'pdfjs-dist/build/pdf.worker.min.mjs'
