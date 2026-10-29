package app.mysafe.core

import java.security.SecureRandom

object PasswordGenerator {
    private val rng = SecureRandom()
    private const val UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"
    private const val LOWER = "abcdefghijkmnopqrstuvwxyz"
    private const val DIGITS = "23456789"
    private const val SYMBOLS = "!@#$%^&*()-_=+[]{};:,.?"

    /** Guarantees at least one character from each selected class; ambiguous glyphs are omitted. */
    fun generate(
        length: Int = 20,
        upper: Boolean = true,
        lower: Boolean = true,
        digits: Boolean = true,
        symbols: Boolean = true,
    ): String {
        val classes = listOfNotNull(
            UPPER.takeIf { upper }, LOWER.takeIf { lower }, DIGITS.takeIf { digits }, SYMBOLS.takeIf { symbols },
        )
        require(classes.isNotEmpty()) { "Select at least one character class" }
        require(length >= classes.size) { "Length too short" }
        val all = classes.joinToString("")
        val chars = classes.map { it[rng.nextInt(it.length)] }.toMutableList()
        while (chars.size < length) chars.add(all[rng.nextInt(all.length)])
        for (i in chars.indices.reversed()) { // Fisher-Yates shuffle
            val j = rng.nextInt(i + 1)
            val t = chars[i]; chars[i] = chars[j]; chars[j] = t
        }
        return chars.joinToString("")
    }
}
