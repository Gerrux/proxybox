fn main() -> Result<(), wdk_build::ConfigError> {
    // Всё, что нужно драйверу от WDK — заголовки, библиотеки, флаги линковки, —
    // подставляет сам wdk-build по окружению eWDK. Руками этот список не
    // повторяют: он разный у KMDF, UMDF и WDM и меняется с версией набора.
    wdk_build::configure_wdk_binary_build()
}
