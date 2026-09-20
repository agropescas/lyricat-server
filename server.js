package app.lyricat.companion

import android.app.Activity
import android.app.AlertDialog
import android.content.res.ColorStateList
import android.graphics.Color
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Painel do aparelho dentro do app (sem WebView): tudo vai pelo servidor, então funciona em casa e fora
 * (Wi-Fi ou dados móveis). O aparelho busca o comando na consulta normal e devolve a configuração dele.
 */
class AparelhoActivity : Activity() {

    private lateinit var ui: Ui
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()

    private var aplicando = false
    private var ultimoEnvio = 0L
    private var offAtual = 0
    private val coresAtuais = Array(12) { "#000000" }
    private var temCfg = false

    private lateinit var chipStatus: TextView
    private lateinit var txtNome: TextView
    private lateinit var txtTocando: TextView
    private lateinit var txtAviso: TextView
    private lateinit var txtBrilho: TextView
    private lateinit var barBrilho: SeekBar
    private lateinit var btnFonte: Button
    private lateinit var swInk: Switch
    private lateinit var btnPausa: Button
    private lateinit var txtOffset: TextView
    private lateinit var btnAnim: Button
    private lateinit var swBrain: Switch
    private lateinit var btnHumor: Button
    private val btnsFala = ArrayList<Button>()
    private val amostras = ArrayList<View>()
    private lateinit var swTema: Switch

    private val ciclo = object : Runnable {
        override fun run() {
            buscar()
            handler.postDelayed(this, 3000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Tema.carregar(this)
        ui = Ui(this)
        Tema.janela(this)

        val raiz = ScrollView(this)
        raiz.setBackgroundColor(Cor.PAPEL)
        val col = LinearLayout(this)
        col.orientation = LinearLayout.VERTICAL
        col.setPadding(ui.dp(16), ui.dp(16), ui.dp(16), ui.dp(28))
        raiz.addView(col, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val voltar = ui.texto("‹ Voltar", 15f, Cor.TINTA, true)
        voltar.setPadding(0, ui.dp(6), ui.dp(16), ui.dp(10))
        voltar.setOnClickListener { finish() }
        col.addView(voltar)

        col.addView(montarStatus(), ui.lp(-1, -2, 0, 14))
        col.addView(montarTela(), ui.lp(-1, -2, 0, 14))
        col.addView(montarLetras(), ui.lp(-1, -2, 0, 14))
        col.addView(montarGato(), ui.lp(-1, -2, 0, 14))
        col.addView(montarCores(), ui.lp(-1, -2, 0, 14))

        setContentView(raiz)
    }

    override fun onResume() {
        super.onResume()
        handler.post(ciclo)
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(ciclo)
    }

    override fun onDestroy() {
        super.onDestroy()
        executor.shutdown()
    }

    // ------------------------------------------------------------------ montagem

    private fun titulo(c: LinearLayout, t: String) {
        c.addView(ui.texto(t, 18f, Cor.TINTA, true))
    }

    private fun rotulo(c: LinearLayout, t: String) {
        c.addView(ui.texto(t, 13f, Cor.CINZA, true), ui.lp(-1, -2, 14, 4))
    }

    private fun seletor(c: LinearLayout, aoTocar: () -> Unit): Button {
        val b = ui.botao("...", false) { aoTocar() }
        c.addView(b, ui.lp(-1, -2, 0, 0))
        return b
    }

    private fun montarStatus(): LinearLayout {
        val c = ui.cartao()
        val cab = LinearLayout(this)
        cab.orientation = LinearLayout.HORIZONTAL
        cab.gravity = Gravity.CENTER_VERTICAL
        txtNome = ui.texto("Meu LyricAT", 20f, Cor.TINTA, true)
        cab.addView(txtNome, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        chipStatus = ui.chip("...", Cor.BEGE, Cor.TINTA)
        cab.addView(chipStatus)
        c.addView(cab)
        txtTocando = ui.texto("", 14f, Cor.TINTA)
        c.addView(txtTocando, ui.lp(-1, -2, 8, 0))
        txtAviso = ui.texto("Os ajustes passam pelo servidor e chegam ao aparelho em alguns segundos.", 12f, Cor.CINZA)
        c.addView(txtAviso, ui.lp(-1, -2, 6, 0))
        return c
    }

    private fun montarTela(): LinearLayout {
        val c = ui.cartao()
        titulo(c, "Tela")

        txtBrilho = ui.texto("Brilho: 100%", 14f, Cor.TINTA, true)
        c.addView(txtBrilho, ui.lp(-1, -2, 10, 2))
        barBrilho = SeekBar(this)
        barBrilho.max = 9   // 10% a 100%
        barBrilho.progress = 9
        barBrilho.progressTintList = ColorStateList.valueOf(Cor.TINTA)
        barBrilho.thumbTintList = ColorStateList.valueOf(Cor.TINTA)
        barBrilho.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar?, p: Int, fromUser: Boolean) {
                txtBrilho.text = "Brilho: " + ((p + 1) * 10) + "%"
            }
            override fun onStartTrackingTouch(s: SeekBar?) {}
            override fun onStopTrackingTouch(s: SeekBar?) {
                if (!aplicando) enviar(JSONObject().put("blPct", (barBrilho.progress + 1) * 10))
            }
        })
        c.addView(barBrilho)

        rotulo(c, "Fonte")
        btnFonte = seletor(c) {
            escolher("Fonte", FONTES) { i -> btnFonte.text = FONTES[i]; enviar(JSONObject().put("font", i)) }
        }

        swInk = Switch(this)
        swInk.text = "Filtro e-ink na capa"
        swInk.setTextColor(Cor.TINTA)
        swInk.setOnCheckedChangeListener { _, marcado -> if (!aplicando) enviar(JSONObject().put("ink", marcado)) }
        c.addView(swInk, ui.lp(-1, -2, 14, 0))

        rotulo(c, "Protetor de tela (música pausada)")
        btnPausa = seletor(c) {
            escolher("Protetor de tela", PAUSAS.map { it.first }) { i ->
                btnPausa.text = PAUSAS[i].first
                enviar(JSONObject().put("pausa", PAUSAS[i].second))
            }
        }
        c.addView(ui.texto("Pausada por esse tempo, a tela apaga e só um aviso apagado passeia por ela (evita burn-in).", 12f, Cor.CINZA), ui.lp(-1, -2, 4, 0))
        return c
    }

    private fun montarLetras(): LinearLayout {
        val c = ui.cartao()
        titulo(c, "Letras")
        c.addView(ui.texto("Letra atrasada? Some para ela aparecer mais cedo. Adiantada? Subtraia. Vale para todas as músicas.", 13f, Cor.CINZA), ui.lp(-1, -2, 4, 8))

        txtOffset = ui.texto("0 ms", 26f, Cor.TINTA, true)
        txtOffset.gravity = Gravity.CENTER
        c.addView(txtOffset, ui.lp(-1, -2, 4, 6))

        c.addView(linhaBotoes(
            listOf("−0,5 s" to { mudarOffset(-500) }, "−0,1 s" to { mudarOffset(-100) }, "+0,1 s" to { mudarOffset(100) }, "+0,5 s" to { mudarOffset(500) })
        ))
        c.addView(linhaBotoes(
            listOf("−10 ms" to { mudarOffset(-10) }, "Zerar" to { definirOffset(0) }, "+10 ms" to { mudarOffset(10) })
        ), ui.lp(-1, -2, 6, 0))

        rotulo(c, "Animação ao trocar de verso")
        btnAnim = seletor(c) {
            escolher("Animação", ANIMACOES) { i -> btnAnim.text = ANIMACOES[i]; enviar(JSONObject().put("anim", i)) }
        }
        return c
    }

    private fun linhaBotoes(itens: List<Pair<String, () -> Unit>>): LinearLayout {
        val l = LinearLayout(this)
        l.orientation = LinearLayout.HORIZONTAL
        for ((i, item) in itens.withIndex()) {
            val b = ui.botao(item.first, false) { item.second() }
            b.textSize = 14f
            b.setPadding(0, 0, 0, 0)
            val p = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            if (i > 0) p.leftMargin = ui.dp(6)
            l.addView(b, p)
        }
        return l
    }

    private fun montarGato(): LinearLayout {
        val c = ui.cartao()
        titulo(c, "Gato & Brain")

        swBrain = Switch(this)
        swBrain.text = "Reações contextuais do gato"
        swBrain.setTextColor(Cor.TINTA)
        swBrain.setOnCheckedChangeListener { _, marcado -> if (!aplicando) enviar(JSONObject().put("brain", marcado)) }
        c.addView(swBrain, ui.lp(-1, -2, 10, 0))

        rotulo(c, "Humor")
        btnHumor = seletor(c) {
            escolher("Humor do gato", HUMORES) { i -> btnHumor.text = HUMORES[i]; enviar(JSONObject().put("humor", i)) }
        }

        rotulo(c, "Frequência das falas")
        val l = LinearLayout(this)
        l.orientation = LinearLayout.HORIZONTAL
        val nomes = listOf("Quieto", "Normal", "Tagarela")
        for (i in 0..2) {
            val b = ui.botao(nomes[i], false) {
                marcarFala(i)
                enviar(JSONObject().put("fala", i))
            }
            b.textSize = 14f
            val p = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
            if (i > 0) p.leftMargin = ui.dp(6)
            l.addView(b, p)
            btnsFala.add(b)
        }
        c.addView(l)
        return c
    }

    private fun montarCores(): LinearLayout {
        val c = ui.cartao()
        titulo(c, "Cores")
        c.addView(ui.texto("Escolha um tema pronto ou toque em uma cor para ajustar.", 13f, Cor.CINZA), ui.lp(-1, -2, 4, 8))

        val nomesPresets = Presets.LISTA.map { it.first }
        c.addView(ui.botao("Escolher um tema pronto", false) {
            escolher("Temas", nomesPresets) { i ->
                val cores = Presets.LISTA[i].second.split("|")
                for (k in 0 until 12) coresAtuais[k] = "#" + cores[k].uppercase()
                pintarAmostras()
                enviarCores()
            }
        })

        val nomes = listOf("Fundo", "Título", "Artista", "Álbum", "Letra", "Pequenos", "Traços", "Barra", "Moldura", "Gato", "Sombras", "Luzes")
        var linha: LinearLayout? = null
        for (i in 0 until 12) {
            if (i % 4 == 0) {
                linha = LinearLayout(this)
                linha.orientation = LinearLayout.HORIZONTAL
                c.addView(linha, ui.lp(-1, -2, 12, 0))
            }
            val cel = LinearLayout(this)
            cel.orientation = LinearLayout.VERTICAL
            cel.gravity = Gravity.CENTER_HORIZONTAL
            val am = View(this)
            am.background = ui.forma(Color.BLACK, Cor.TINTA, 10, 2)
            am.setOnClickListener { editarCor(i) }
            cel.addView(am, LinearLayout.LayoutParams(ui.dp(52), ui.dp(40)))
            cel.addView(ui.texto(nomes[i], 11f, Cor.CINZA), ui.lp(-2, -2, 3, 0))
            amostras.add(am)
            linha!!.addView(cel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }

        swTema = Switch(this)
        swTema.text = "App com as cores do aparelho"
        swTema.setTextColor(Cor.TINTA)
        swTema.isChecked = Prefs.temaOn(this)
        swTema.setOnCheckedChangeListener { _, marcado ->
            Prefs.setTemaOn(this, marcado)
            if (!marcado) Prefs.setTema(this, "")
            recreate()
        }
        c.addView(swTema, ui.lp(-1, -2, 16, 0))
        return c
    }

    // ------------------------------------------------------------------ ações

    private fun escolher(titulo: String, itens: List<String>, aoEscolher: (Int) -> Unit) {
        AlertDialog.Builder(this)
            .setTitle(titulo)
            .setItems(itens.toTypedArray()) { _, i -> if (!aplicando) aoEscolher(i) }
            .show()
    }

    private fun textoOffset(v: Int): String = (if (v > 0) "+" else "") + v + " ms"

    private fun mudarOffset(delta: Int) = definirOffset(offAtual + delta)

    private fun definirOffset(v: Int) {
        offAtual = v.coerceIn(-5000, 5000)
        txtOffset.text = textoOffset(offAtual)
        enviar(JSONObject().put("offG", offAtual))
    }

    private fun marcarFala(sel: Int) {
        for ((i, b) in btnsFala.withIndex()) ui.estilizar(b, i == sel)
    }

    private fun hex(cor: Int): String = String.format("#%06X", 0xFFFFFF and cor)

    private fun pintarAmostras() {
        for (i in 0 until 12) {
            val cor = try { Color.parseColor(coresAtuais[i]) } catch (e: Exception) { Color.BLACK }
            amostras[i].background = ui.forma(cor, Cor.TINTA, 10, 2)
        }
    }

    private fun enviarCores() {
        val arr = JSONArray()
        for (h in coresAtuais) arr.put(h)
        enviar(JSONObject().put("cores", arr))
    }

    private fun editarCor(i: Int) {
        val atual = try { Color.parseColor(coresAtuais[i]) } catch (e: Exception) { Color.BLACK }
        val caixa = LinearLayout(this)
        caixa.orientation = LinearLayout.VERTICAL
        caixa.setPadding(ui.dp(20), ui.dp(12), ui.dp(20), ui.dp(4))
        val previa = View(this)
        previa.setBackgroundColor(atual)
        caixa.addView(previa, LinearLayout.LayoutParams(-1, ui.dp(48)))
        val txt = ui.texto(hex(atual), 14f, Color.DKGRAY, true)
        caixa.addView(txt, ui.lp(-1, -2, 6, 0))
        val barras = ArrayList<SeekBar>()
        val iniciais = intArrayOf(Color.red(atual), Color.green(atual), Color.blue(atual))
        val nomes = listOf("Vermelho", "Verde", "Azul")
        for (k in 0..2) {
            caixa.addView(ui.texto(nomes[k], 12f, Color.DKGRAY), ui.lp(-1, -2, 8, 0))
            val sb = SeekBar(this)
            sb.max = 255
            sb.progress = iniciais[k]
            caixa.addView(sb)
            barras.add(sb)
        }
        val ouvinte = object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(s: SeekBar?, p: Int, fromUser: Boolean) {
                val cor = Color.rgb(barras[0].progress, barras[1].progress, barras[2].progress)
                previa.setBackgroundColor(cor)
                txt.text = hex(cor)
            }
            override fun onStartTrackingTouch(s: SeekBar?) {}
            override fun onStopTrackingTouch(s: SeekBar?) {}
        }
        for (b in barras) b.setOnSeekBarChangeListener(ouvinte)
        AlertDialog.Builder(this)
            .setTitle("Ajustar cor")
            .setView(caixa)
            .setPositiveButton("Aplicar") { _, _ ->
                coresAtuais[i] = hex(Color.rgb(barras[0].progress, barras[1].progress, barras[2].progress))
                pintarAmostras()
                enviarCores()
            }
            .setNegativeButton("Cancelar", null)
            .show()
    }

    // ------------------------------------------------------------------ rede

    private fun enviar(j: JSONObject) {
        ultimoEnvio = System.currentTimeMillis()
        val code = Prefs.code(this)
        executor.execute {
            val r = Remoto.enviarCmd(code, j)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                if (!r.ok) {
                    Toast.makeText(this, r.erro, Toast.LENGTH_LONG).show()
                } else if (r.aparelho < 0 || r.aparelho > 60) {
                    txtAviso.text = "O aparelho parece desligado ou sem Wi-Fi. O ajuste fica guardado por 10 minutos e vale quando ele voltar."
                } else {
                    txtAviso.text = "Enviado. O aparelho aplica em alguns segundos."
                }
            }
        }
    }

    private fun buscar() {
        val code = Prefs.code(this)
        if (code.length != 12) return
        executor.execute {
            val r = Remoto.lerCfg(code)
            runOnUiThread { if (!isFinishing && !isDestroyed) mostrar(r) }
        }
    }

    private fun mostrar(r: Remoto.RespCfg) {
        val online = r.aparelho in 0..30
        when {
            r.erro.isNotEmpty() -> ui.ajustarChip(chipStatus, "SEM REDE", Cor.VERMELHO, Cor.BRANCO)
            online -> ui.ajustarChip(chipStatus, "ONLINE", Cor.VERDE, Cor.BRANCO)
            r.aparelho < 0 -> ui.ajustarChip(chipStatus, "SEM APARELHO", Cor.AMBAR, Cor.BRANCO)
            else -> ui.ajustarChip(chipStatus, "OFFLINE", Cor.AMBAR, Cor.BRANCO)
        }
        val cfg = r.cfg
        if (!r.ok || cfg == null) {
            if (r.erro.isNotEmpty()) txtAviso.text = r.erro
            else if (!temCfg) txtAviso.text = "Aguardando o aparelho mandar a configuração. Ele precisa estar ligado, no Wi-Fi e com o firmware 1.8e ou mais novo."
            return
        }
        temCfg = true
        txtNome.text = cfg.optString("nome", "Meu LyricAT")
        val t = cfg.optString("t", "")
        val a = cfg.optString("a", "")
        txtTocando.text = if (t.isNotEmpty()) "Tocando: $t" + (if (a.isNotEmpty()) " · $a" else "") else "Nada tocando agora."
        if (System.currentTimeMillis() - ultimoEnvio < 5000L) return   // não briga com o que você acabou de mexer

        aplicando = true
        val bl = cfg.optInt("blPct", 100).coerceIn(10, 100)
        barBrilho.progress = (bl / 10 - 1).coerceIn(0, 9)
        txtBrilho.text = "Brilho: $bl%"
        btnFonte.text = FONTES.getOrElse(cfg.optInt("font", 0)) { FONTES[0] }
        swInk.isChecked = cfg.optBoolean("ink", true)
        val pausa = cfg.optInt("pausa", 5)
        btnPausa.text = (PAUSAS.firstOrNull { it.second == pausa } ?: PAUSAS[0]).first
        offAtual = cfg.optInt("offG", 0)
        txtOffset.text = textoOffset(offAtual)
        btnAnim.text = ANIMACOES.getOrElse(cfg.optInt("anim", 0)) { ANIMACOES[0] }
        swBrain.isChecked = cfg.optBoolean("brain", true)
        btnHumor.text = HUMORES.getOrElse(cfg.optInt("humor", 0)) { HUMORES[0] }
        marcarFala(cfg.optInt("fala", 1))
        val arr = cfg.optJSONArray("cores")
        if (arr != null && arr.length() == 12) {
            for (i in 0 until 12) coresAtuais[i] = arr.optString(i, "#000000")
            pintarAmostras()
            if (Prefs.temaOn(this)) {
                val junto = coresAtuais.joinToString("|")
                if (junto != Prefs.tema(this)) {
                    Prefs.setTema(this, junto)
                    aplicando = false
                    recreate()
                    return
                }
            }
        }
        aplicando = false
    }

    companion object {
        val PAUSAS = listOf("Nunca" to 0, "5 min" to 5, "10 min" to 10, "15 min" to 15, "30 min" to 30, "60 min" to 60)
        val FONTES = listOf("Clássica", "Compacta", "Forte", "Helvética", "Serifada (Times)", "Livro (Century)",
            "Máquina de escrever", "Redonda", "Limpa", "Lucida")
        val ANIMACOES = listOf("Instantânea", "Deslizar", "Fade", "Palavra por palavra", "Digitação")
        val HUMORES = listOf("Auto", "Calmo", "Sarcástico", "Sonolento", "Energético", "DJ", "Caótico", "Nerd",
            "Dramático", "Rabugento", "Fofo", "Gremlin", "Secretário")
    }
}
