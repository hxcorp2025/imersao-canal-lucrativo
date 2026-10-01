// Publicação segura no Cloudflare Pages, rodando no GitHub Actions a cada push no main (01/10/2026).
// Versão em Node do setup/pages-deploy-seguro.ps1 do cérebro da HX, com as mesmas conferências:
//   1. o pacote é o repositório inteiro (git archive do commit), menos a pasta .github;
//   2. ANTES de publicar, lê o registro do que está no ar (/_publicado.json, hashes dos arquivos) e BLOQUEIA se alguma
//      página sumiria. Tirar página do ar de propósito: apagar no git e pôr [remover] na mensagem do commit;
//   3. publica com o wrangler e grava o registro novo (mesmo formato do script do PC: os dois convivem);
//   4. DEPOIS confere que o registro novo apareceu e que cada página responde 200. Falhou = sai com erro e mostra o rollback.
// Uso: node .github/publicar/publicar-seguro.mjs --projeto ja-aula --dominio aula.joaoadolfooficial.com [--dry-run]
// Precisa de CLOUDFLARE_API_TOKEN (só Pages: editar) e CLOUDFLARE_ACCOUNT_ID no ambiente (secrets do repositório).
import { execSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null }
const PROJETO = arg('--projeto')
const DOMINIO = (arg('--dominio') || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '')
const DRY = process.argv.includes('--dry-run')
if (!PROJETO || !DOMINIO) { console.error('uso: --projeto <nome> --dominio <dominio> [--dry-run]'); process.exit(2) }
const IGNORAR = [/^assets\//, /^_next\//, /\.map$/]
const ESPECIAIS = new Set(['_publicado.json', '_headers', '_redirects', '_routes.json', '_worker.js'])
const sh = (c, o = {}) => execSync(c, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...o })

const hash = (p) => createHash('sha256').update(`${PROJETO}|${p}`, 'utf8').digest('hex')
const protegido = (p) => !ESPECIAIS.has(p) && !p.split('/').pop().startsWith('.') && !IGNORAR.some((r) => r.test(p))
const urlDa = (p) => p === 'index.html' ? `https://${DOMINIO}/`
  : p.endsWith('/index.html') ? `https://${DOMINIO}/${p.slice(0, -10)}` : `https://${DOMINIO}/${p.slice(0, -5)}`
async function status(u) { try { return (await fetch(u, { redirect: 'follow', signal: AbortSignal.timeout(30000) })).status } catch { return 0 } }
async function registroNoAr() {
  const u = `https://${DOMINIO}/_publicado.json?t=${Date.now()}`
  let r
  try { r = await fetch(u, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(30000) }) } catch (e) {
    throw new Error(`Não consegui ler o registro no ar (${u}): ${e.message}. Sem ele não dá pra garantir nada.`)
  }
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`Registro no ar respondeu ${r.status} (${u})`)
  try { const j = await r.json(); return j && Array.isArray(j.arquivos) ? j : null } catch { return null }
}
function listar(raiz) {
  const out = []
  const anda = (d) => { for (const n of readdirSync(d)) { const c = join(d, n); statSync(c).isDirectory() ? anda(c) : out.push(relative(raiz, c).split(sep).join('/')) } }
  anda(raiz)
  return out
}

const gitCurto = sh('git rev-parse --short HEAD').trim()
const mensagem = process.env.COMMIT_MSG || sh('git log -1 --pretty=%B')
const removerPermitido = /\[remover\]/i.test(mensagem)

// 1. pacote
console.log(`1/5 Montando o pacote do commit ${gitCurto} (sem .github)`)
const pkg = mkdtempSync(join(tmpdir(), `pages-${PROJETO}-`))
sh(`git archive --format=tar HEAD -- . ":(exclude).github" | tar -x -C "${pkg.replace(/\\/g, '/')}"`, { shell: process.platform === 'win32' ? 'bash' : '/bin/sh' })
const todos = listar(pkg)
const prot = todos.filter(protegido).sort()
if (!prot.length) throw new Error('Pacote vazio ou sem arquivo protegido')
const novo = new Map(prot.map((p) => [hash(p), p]))
const nomes = new Map()
for (const p of sh('git log --all --name-only --pretty=format:').split('\n').map((s) => s.trim()).filter(Boolean)) nomes.set(hash(p), p)
console.log(`   ${todos.length} arquivos, ${prot.length} protegidos`)

// 2. trava
console.log(`2/5 Conferindo o que está no ar em https://${DOMINIO}`)
const noAr = await registroNoAr()
if (!noAr) {
  if (process.env.SEM_REGISTRO_OK !== '1') throw new Error(`Sem registro no ar em ${DOMINIO}: 1ª publicação protegida. Confira o site e rode com SEM_REGISTRO_OK=1.`)
  console.log('   sem registro no ar: este deploy cria o registro')
} else {
  console.log(`   registro no ar: ${noAr.total} arquivos, publicado ${noAr.publicado_em} por ${noAr.origem} (git ${noAr.git})`)
  const somem = noAr.arquivos.filter((h) => !novo.has(h)).map((h) => nomes.get(h) || `(arquivo sem nome conhecido, hash ${h.slice(0, 12)})`)
    .filter((n) => !n.startsWith('.github/')) // a automação nunca vai pro site; se um envio do PC levou, não conta como página
  if (somem.length && !removerPermitido) {
    console.log('   BLOQUEADO: este deploy APAGARIA do ar:'); somem.forEach((s) => console.log(`     - ${s}`))
    console.log('   Se é de propósito: apague no git e ponha [remover] na mensagem do commit.')
    process.exit(1)
  }
  if (somem.length) { console.log('   [remover] na mensagem: saem do ar de propósito:'); somem.forEach((s) => console.log(`     - ${s}`)) }
  else console.log('   OK: nada que está no ar vai sumir')
}

// 3. registro novo dentro do pacote
const id = randomUUID()
const registro = { id, projeto: PROJETO, publicado_em: new Date().toISOString(), origem: 'GitHub-Actions', git: gitCurto, total: prot.length, arquivos: [...novo.keys()].sort() }
writeFileSync(join(pkg, '_publicado.json'), JSON.stringify(registro))
if (DRY) console.log(`\nDRY-RUN: tudo conferido, nada publicado. Pacote em ${pkg}`)
else await publicar()

async function publicar() {
// 4. publica
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) throw new Error('Faltam CLOUDFLARE_API_TOKEN e CLOUDFLARE_ACCOUNT_ID')
console.log(`3/5 Publicando ${PROJETO} (main)`)
const msg = `deploy-seguro_GitHub-Actions_git-${gitCurto}`
sh(`npx --yes wrangler@4 pages deploy "${pkg}" --project-name ${PROJETO} --branch main --commit-dirty=true --commit-message "${msg}"`, { stdio: 'inherit' })

// 5. prova no ar
console.log('4/5 Conferindo o registro novo no ar')
let ok = false
for (let i = 0; i < 18 && !ok; i++) {
  const r = await registroNoAr().catch(() => null)
  if (r && r.id === id) ok = true; else await new Promise((s) => setTimeout(s, 5000))
}
const falhas = ok ? [] : [`registro novo não apareceu em https://${DOMINIO}/_publicado.json em 90 s`]
console.log('5/5 Conferindo cada página')
for (const p of prot.filter((p) => p.endsWith('.html')).slice(0, 80)) {
  const u = urlDa(p); const s = await status(u)
  if (s !== 200) falhas.push(`${u} -> ${s}`); else console.log(`   200 ${u}`)
}
if (falhas.length) {
  console.log('\nPUBLICOU, MAS A CONFERÊNCIA FALHOU:'); falhas.forEach((f) => console.log(`  - ${f}`))
  console.log(`Rollback: npx wrangler pages deployment list --project-name ${PROJETO}  ->  npx wrangler pages deployment rollback <id>`)
  process.exit(1)
}
console.log(`\nPRONTO: ${prot.filter((p) => p.endsWith('.html')).length} páginas conferidas com 200 em https://${DOMINIO}`)
}
