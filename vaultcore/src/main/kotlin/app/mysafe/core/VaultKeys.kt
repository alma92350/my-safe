package app.mysafe.core

/** Key hierarchy: vault master key (VMK) -> index key, per-file key-encryption key. */
object VaultKeys {
    private val RECOVERY_AAD = "mysafe-vmk-recovery-v1".toByteArray()

    fun newMasterKey(): ByteArray = Crypto.randomBytes(Crypto.KEY_LEN)

    fun wrapWithRecovery(vmk: ByteArray, key: RecoveryKey): ByteArray =
        Crypto.seal(key.wrapKey(), vmk, RECOVERY_AAD)

    fun unwrapWithRecovery(wrapped: ByteArray, key: RecoveryKey): ByteArray =
        Crypto.open(key.wrapKey(), wrapped, RECOVERY_AAD)

    fun indexKey(vmk: ByteArray): ByteArray = Crypto.hkdf(vmk, "mysafe/index/v1")

    fun fileKek(vmk: ByteArray): ByteArray = Crypto.hkdf(vmk, "mysafe/file-kek/v1")
}
