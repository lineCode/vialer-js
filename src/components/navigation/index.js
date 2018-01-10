module.exports = (app, actions) => {

    return {
        methods: {
            logout: actions.logout,
            setLayer: function(layerName) {
                this.$store.ui.layer = layerName
                app.emit('bg:set_state', {
                    persist: true,
                    state: {
                        ui: this.$store.ui,
                    },
                })
            },
        },
        render: templates.navigation.r,
        staticRenderFns: templates.navigation.s,
        store: {
            layer: 'ui.layer',
            user: 'user',
        },
    }
}