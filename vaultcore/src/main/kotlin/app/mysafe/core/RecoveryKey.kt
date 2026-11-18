package app.mysafe.core

/**
 * 256-bit recovery key, displayed as 13 groups of 4 base32 characters
 * (52 characters = 260 bits; the final 4 bits are zero padding).
 */
class RecoveryKey private constructor(private val bytes: ByteArray) {

    /** Key used to wrap the vault master key. */
    fun wrapKey(): ByteArray = Crypto.hkdf(bytes, "mysafe/recovery-wrap/v1")

    fun groups(): List<String> = encode(bytes).chunked(GROUP_LEN)

    fun format(): String = groups().joinToString("-")

    fun wipe() = bytes.fill(0)

    companion object {
        const val GROUP_LEN = 4
        const val GROUP_COUNT = 13
        private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

        fun generate() = RecoveryKey(Crypto.randomBytes(Crypto.KEY_LEN))

        /** Accepts any case; ignores spaces, dashes and line breaks. */
        fun parse(text: String): RecoveryKey {
            val clean = text.uppercase().filter { it != '-' && !it.isWhitespace() }
            require(clean.length == GROUP_LEN * GROUP_COUNT) { "Recovery key must have 52 characters" }
            var acc = 0
            var bits = 0
            val out = ArrayList<Byte>(Crypto.KEY_LEN)
            for (ch in clean) {
                val v = ALPHABET.indexOf(ch)
                require(v >= 0) { "Invalid character '$ch' in recovery key" }
                acc = (acc shl 5) or v
                bits += 5
                if (bits >= 8) {
                    bits -= 8
                    out.add(((acc shr bits) and 0xFF).toByte())
                    acc = acc and ((1 shl bits) - 1)
                }
            }
            require(acc == 0) { "Invalid recovery key" } // padding bits must be zero
            return RecoveryKey(out.toByteArray())
        }

        private fun encode(data: ByteArray): String {
            val sb = StringBuilder()
            var acc = 0
            var bits = 0
            for (b in data) {
                acc = (acc shl 8) or (b.toInt() and 0xFF)
                bits += 8
                while (bits >= 5) {
                    bits -= 5
                    sb.append(ALPHABET[(acc shr bits) and 31])
                }
                acc = acc and ((1 shl bits) - 1)
            }
            if (bits > 0) sb.append(ALPHABET[(acc shl (5 - bits)) and 31])
            return sb.toString()
        }
    }
}
